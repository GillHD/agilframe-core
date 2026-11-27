# AgilFrame — AWS reference (Terraform)

One deliberately boring AWS shape for a first customer/demo deployment:

```
                 Route53 (optional)
        calls.example.com        turn.example.com
                 │                     │
        ┌────────▼────────┐   ┌────────▼────────┐
        │ core VM         │   │ node VM(s)      │
        │ Ubuntu 22.04    │   │ Ubuntu 22.04    │
        │ Docker+Compose  │   │ Docker+Compose  │
        │ :80/:443 proxy  │   │ :3478 TURN      │
        │ :8787 core      │◄──┤ relay UDP range │
        │ EIP             │   │ EIP             │
        └────────┬────────┘   └─────────────────┘
                 │
        public subnets (2 AZs) + IGW
```

It provisions **only infrastructure**: VPC, two public subnets, internet
gateway, security groups, EC2 VMs with Docker + Compose installed, Elastic IPs
and optional Route53 A records. It does **not** deploy AGIL, generate secrets,
provision certificates or touch any existing production account resources
beyond what you name here.

> Reference quality, not a hardened landing zone. Public subnets are used
> because TURN/SFU need public IPs; there is no NAT, ALB, WAF or backup policy.
> Review `terraform plan` and adapt before a real customer.

## Prerequisites

| Need | Details |
|---|---|
| Terraform | ≥ 1.9 (cross-variable validation; validated with 1.16) |
| AWS credentials | profile, env vars or SSO; permission to create VPC/EC2/EIP/Route53 and IAM roles/instance profiles (for SSM) |
| EC2 key pair | optional: set `ssh_key_name`, or leave empty and use SSM Session Manager (`enable_ssm = true`, default) |
| Admin CIDR | your office/home/CI egress IP as `/32` (`admin_cidr`) — required; `/0` is rejected |
| Domain + zone | optional; only for `create_dns_records=true` (Route53 zone id `Z…`) |
| Region | default `eu-central-1` |

## Apply

```bash
cd agil/infra/terraform/aws
cp terraform.tfvars.example terraform.tfvars   # gitignored
# edit admin_cidr, ssh_key_name (or use SSM), domain, sizes

terraform init
terraform fmt -check
terraform validate
terraform plan -out plan.tfplan
terraform apply plan.tfplan
```

`admin_cidr = "0.0.0.0/0"` (or `::/0`) now fails at **plan time** with an
actionable error. The only escape hatch is `allow_world_admin = true`, intended
for a throwaway demo; never enable it for a customer deployment.

Outputs include the EIPs, SSH **and SSM** commands, core public/private URLs,
public origin, DNS names, security group ids and a **TURN ICE template with
`<TURN_PASSWORD>` placeholder** (never a real credential). Use them like this:

```bash
terraform output -json | jq
terraform output next_steps
terraform output core_private_url   # AGIL_CORE_URL for node VMs in this VPC
```

### Core host

```bash
git clone <your-repo> /opt/agil/src
cd /opt/agil/src/agil/infra/quickstart
./install.sh --domain calls.example.com \
  --turn-ip "$(curl -fsS http://169.254.169.254/latest/meta-data/public-ipv4)" \
  --ice-host turn.example.com \
  --start
```

Pass `--ice-host` whenever TURN runs on a **different host** than core (the
Terraform default: core VM + node VM). Without it the ICE list points clients at
the core hostname and relay fails. Use the TURN hostname or, before DNS exists,
the node's public IP.

### Node host (remote node profile)

The node VM must **not** run the all-in-one stack: that would start its own core
and the core VM's registry would never see the node (P2-4). Use the node/TURN
bundle against the remote core, starting from
[`../../quickstart/node.env.example`](../../quickstart/node.env.example) (it has
no core secrets):

```bash
git clone <your-repo> /opt/agil/src
cd /opt/agil/src/agil/infra/quickstart
cp node.env.example .env   # node/TURN template; no core secrets
# set TURN_* for this host; mint a node token on core (dashboard ->
# Infrastructure, or POST /v1/admin/cluster/tokens) and set:
#   AGIL_NODE_TOKEN=agil_enr_...
#   AGIL_CORE_URL=$(terraform output -raw core_private_url)   # same VPC
#   (or the public https origin when the node is outside the VPC)
docker compose -f docker-compose.node.yml -f docker-compose.node-remote.yml up -d
```

`docker-compose.node-remote.yml` removes the local-core `depends_on` edge and
makes `AGIL_CORE_URL` mandatory, so a node can never silently register with a
local core. The node key is stored in the `node-state` volume; the token is
burned after the first registration.

Cloud-init already installed Docker Engine + Compose v2, set log rotation,
sysctl tuning, enabled the SSM agent when present and wrote hints to
`/etc/agil/quickstart.env` (including `AGIL_CORE_URL` for the node role). It does
not clone the repo or write secrets.

## TLS (intentional manual step)

No certificate is provisioned. Options:

1. **Caddy on the core VM (recommended for the quickstart).** Point
   `calls.example.com` at the core EIP, open 80/443 (done by this module), use
   [`../../examples/caddy/Caddyfile`](../../examples/caddy/Caddyfile). Caddy
   obtains and renews Let's Encrypt certificates automatically.
2. **nginx + certbot** on the core VM. Use
   [`../../examples/nginx/agil.conf`](../../examples/nginx/agil.conf) and the
   certbot webroot path in that file.
3. **ACM + ALB** for a managed edge: request/validate the certificate in ACM,
   put an ALB in front of the core instance (target 8787), and use the ALB DNS
   name or a Route53 alias. This module does not create the ALB; open the
   instance SG to the ALB subnets instead of the world if you add one.
4. **External CDN/WAF** (Cloudflare etc.): terminate TLS there and restrict
   ports 80/443 to the provider ranges. Do not enable "proxy" for TURN/SFU
   hostnames — media is UDP and must go direct to the EIP.

TURN over TLS (`turns:5349`) additionally needs a certificate mounted into
coturn. The security group rule is **closed by default**; set
`enable_turn_tls = true` only when you actually mount a certificate and run
coturn with TLS. Plain `turn:`/`stun:` works without it and should remain as a
fallback.

## Ports opened

| Where | Port / proto | Source | Why |
|---|---|---|---|
| core SG | 80, 443/tcp | `0.0.0.0/0` (toggle `public_web_enabled`) | TLS proxy + ACME |
| core SG | 22/tcp (`ssh_port`) | `admin_cidr` | admin |
| core SG | 8787/tcp | `admin_cidr` and node SG | smoke/doctor + node enrollment |
| node SG | 22/tcp | `admin_cidr` | admin |
| node SG | 3478/tcp+udp | `0.0.0.0/0` | STUN/TURN |
| node SG | 5349/tcp | `0.0.0.0/0` only if `enable_turn_tls` | TURN over TLS |
| node SG | relay range UDP (49200–49250) | `0.0.0.0/0` | TURN media |
| node SG | 7880/7881/tcp, 50000–50100/udp | `0.0.0.0/0` only if `enable_sfu_ports` | LiveKit |

The relay range is published 1:1 (host == container == coturn
`--min-port/--max-port`). If you change `turn_relay_min_port/max_port`, change
the quickstart `.env` to the same values and open the **same** range here and on
the host firewall; a shifted mapping gives "ICE connects, no media".

`0.0.0.0/0` on TURN/media is intentional (participants are everywhere). SSH is
never world-open. AWS security groups are stateful, so return traffic is
implicit. Docker-published ports bypass host `ufw`; these security groups are
the real boundary.

## Security and state

- **No secrets in code, tfvars or outputs.** TURN password, API keys and token
  secrets are generated on the host by `install.sh` (mode 0600) or by your
  secret manager.
- `terraform.tfvars`, `*.tfstate*`, `.terraform/` and the plan file are
  gitignored. State is local by default and contains resource ids/IPs, not
  secrets. For a customer deployment, configure an encrypted S3 backend with
  DynamoDB locking **before** the first apply.
- EC2 IMDSv2 is required (`http_tokens = "required"`), root EBS is encrypted,
  detailed monitoring is optional.
- `admin_cidr` is validated: a `/0` route is rejected at plan time unless
  `allow_world_admin = true` (demo escape hatch only). Keep it to your egress
  `/32`.
- `enable_ssm = true` (default) creates an IAM role with
  `AmazonSSMManagedInstanceCore` plus an instance profile attached to every VM.
  Use `terraform output ssm_session_commands` when you deliberately leave
  `ssh_key_name` empty. Set `enable_ssm = false` only if you attach your own
  profile/role outside this module.
- The module creates an internet gateway but no flow logs, WAF, GuardDuty or
  backup plan. Add those in the account's baseline.

## Operations

| Task | How |
|---|---|
| Replace/upgrade AGIL | SSH, `git pull`, `docker compose up -d --build`, `./doctor.sh` |
| Change instance size | edit `core_instance_type`, `terraform apply` (instance replacement; EIP re-associates) |
| Add a node | increase `node_count`, apply, then run the node/TURN bundle on the new host (see "Node host") and enroll it with a fresh token |
| Update cloud-init | `user_data_replace_on_change=false`; changes apply to **new** instances only |
| Backups | not provisioned: snapshot the core EBS volume / use `agil/core/scripts/backup-data.sh` |
| Teardown | `terraform destroy` (deletes instances and **EBS volumes**; back up `.data` first) |

EIPs survive instance replacement within the apply, but `terraform destroy`
releases them; DNS records are removed with the stack.

## Cost sketch (eu-central-1, on-demand, 2026 prices change)

- 2 × `t3.small` ≈ $30/month compute
- 2 × 30 GiB gp3 ≈ $5/month storage
- 2 × Elastic IP (attached) ≈ $0–8/month
- bandwidth: the real variable — TURN/SFU media can move hundreds of GB.

Use the AWS calculator for a quote; the module's defaults are sized for a demo,
not 50 concurrent calls.

## Limitations / gaps

- Single region, one VPC, public subnets only (no private subnet/NAT pattern).
- IPv4 only; no IPv6.
- No autoscaling group or load balancer; a VM replacement is a short outage.
- No automated TLS or certificate renewal.
- No Route53 health checks/failover; TURN record is the first node only.
- No CloudWatch alarms/log shipping; use the observability kit in
  `agil/core/deploy/observability/`.
- The module does not install AGIL itself — that is deliberate (no secrets in
  user data, no repo coupling). Node VMs use the quickstart's node/TURN bundle
  (see "Node host" above), not the all-in-one installer.

## Validation performed

```bash
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
```

`terraform validate` requires access to the AWS provider registry (or a
filesystem mirror). The `admin_cidr` validation and the `check` blocks were
exercised with `terraform plan` against an invalid CIDR; no plan/apply creates
real infrastructure in the repository tooling.
