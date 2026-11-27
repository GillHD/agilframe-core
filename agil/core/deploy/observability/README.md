# AgilFrame — observability kit (optional, not deployed)

Prometheus scrape config, alert rules, blackbox modules and a minimal Grafana
dashboard for the AgilFrame production stack (app + 2 LiveKit SFU nodes + Redis
+ egress worker). Nothing in this directory is applied by the repository and no
secrets are stored here.

The full operational context — SLOs, thresholds, runbooks — is in
[`agil/core/docs/operations.md`](../../docs/operations.md). This README is only about
running and validating the monitoring stack.

## Files

| File | Purpose |
|---|---|
| `prometheus.yml` | scrape jobs for app probes, SFU nodes, egress, hosts, optional cAdvisor/Redis |
| `blackbox.yml` | `http_2xx` and `tcp_connect` prober modules |
| `agil-alerts.yml` | alert rules (availability, capacity, data) with runbook labels |
| `grafana/agil-calls-ops.json` | minimal dashboard: health, cert, rooms, participants, NACK, CPU/mem/disk, egress |
| `grafana/provisioning/...` | datasource (uid `prometheus`) and dashboard provider |
| `docker-compose.yml` | loopback-only stack: Prometheus, blackbox, Grafana, optional cAdvisor |

## Before starting

1. Replace the placeholders in `prometheus.yml`:
   - `calls.example.com` → the public app domain;
   - `sfu-1.internal`, `sfu-2.internal`, `egress.internal`, `server3.internal` →
     real hosts reachable from the monitoring host;
   - ports `6789`/`6790` must match `prometheus.port` in
     `agil/core/deploy/livekit/livekit.yaml` and `livekit-node2.yaml`; egress metrics use
     `prometheus_port: 9090` from `agil/core/deploy/egress/egress.yaml`.
2. Make sure the monitoring host can reach those ports over the private
   network. Do not expose `:6789`, `:6790`, `:8080`, `:9090` or Prometheus
   publicly — they have no authentication and name internal hosts.
3. Set a Grafana admin password (no default is shipped):

   ```bash
   export GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 16)"
   docker compose -f agil/core/deploy/observability/docker-compose.yml up -d
   ssh -L 3000:127.0.0.1:3000 user@monitoring-host   # then http://127.0.0.1:3000
   ```

   All published ports bind to `127.0.0.1` (Prometheus 9090, blackbox 9115,
   Grafana 3000, cAdvisor 8081). Use SSH tunnels or a private reverse proxy.

4. For per-container CPU/RAM/restarts: start with
   `--profile cadvisor` and uncomment the `cadvisor` job in `prometheus.yml`.
   For Redis monitoring, add a `redis_exporter` and uncomment its job.

## What the jobs measure

| Job | Target | Metrics used by the dashboard/alerts |
|---|---|---|
| `agil-app-health` | blackbox → `https://calls.example.com/v1/health` | `probe_success`, `probe_duration_seconds`, `probe_ssl_earliest_cert_expiry` |
| `agil-egress-health` | blackbox → `http://egress.internal:8080/` | `probe_success` |
| `agil-sfu-tcp` | blackbox TCP → 7880/7890 | `probe_success` |
| `agil-sfu-1/2` | LiveKit `:6789`, `:6790` | `livekit_room_total`, `livekit_participant_total`, `livekit_nack_total`, `livekit_packet_total`, `livekit_rtt_ms` |
| `agil-sfu-egress` | egress `:9090` | `livekit_egress_available` |
| `node` | node_exporter `:9100` | `node_cpu_seconds_total`, `node_memory_*`, `node_filesystem_*` |
| `cadvisor` (optional) | `:8081` | `container_memory_working_set_bytes`, `container_start_time_seconds` |
| `redis` (optional) | redis_exporter `:9121` | `redis_up` |

There is deliberately **no job for the app's own `/metrics`**: the app exposes
only `/v1/health`. Pointing Prometheus at `:8787/metrics` would create permanent
`up == 0` noise.

Metric names differ between LiveKit versions. Verify against the running node
before trusting an alert:

```bash
curl -fsS http://127.0.0.1:6789/metrics | grep '^livekit_' | cut -d'{' -f1 | sort -u
```

## Backup freshness metric

`AgilBackupStale` / `AgilBackupMissing` rely on
`agil_backup_last_success_timestamp_seconds`. Produce it with
`node_exporter --collector.textfile.directory=/var/lib/node_exporter/textfile`
and run the backup with:

```bash
agil/core/scripts/backup-data.sh --metrics-textfile /var/lib/node_exporter/textfile/agil_backup.prom ...
```

Without that flag the metric does not exist and the backup alerts stay inactive —
monitor the cron mail/log instead.

## Alerting

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager.internal:9093"]
```

Add an Alertmanager (or Grafana Alerting) for routing. The rules carry
`severity` (`critical` → page, `warning` → ticket) and a `runbook` label pointing
at the matching section of `agil/core/docs/operations.md`. Thresholds are starting points;
tune after two weeks of baseline and delete alerts nobody acts on.

## Grafana notes

- The dashboard JSON references the datasource **uid `prometheus`**, which the
  provisioning file creates. If you import it into an existing Grafana, either
  give your Prometheus datasource that uid or bulk-replace
  `"uid": "prometheus"` in the JSON.
- Import manually: Dashboards → New → Import → upload
  `grafana/agil-calls-ops.json`.
- The dashboard's "runbook" link is a placeholder URL; point it at your internal
  page.

## Validation

The config was validated without deploying anything:

- `prometheus.yml`, `blackbox.yml`, `agil-alerts.yml`,
  `grafana/provisioning/**/*.yml` and `docker-compose.yml` parse as YAML
  (PyYAML), and `docker compose config` can be used on a host with Docker;
- `grafana/agil-calls-ops.json` parses as JSON and every panel has a unique id,
  a datasource and at least one target;
- PromQL expressions were reviewed by hand against the metric list above; run
  `promtool check rules agil-alerts.yml` and `promtool check config
  prometheus.yml` on the monitoring host before reloading.
- Run `promtool test rules agil-node-alerts.test.yml` to verify agent
  reachability, heartbeat and media readiness separately, including planned drain.
  [Media node setup](../../docs/node-image.md#monitor-the-node)

## Limitations

- No app-level metrics (no app code changes in this kit): request rates, 5xx
  ratios, room create/join outcomes need log-based metrics from the proxy/app
  logs.
- Media quality SLOs need client telemetry; `livekit_*` metrics cover the SFU,
  not the endpoint.
- The optional stack is a reference, not an HA monitoring deployment: one
  Prometheus, local TSDB, no Alertmanager. For production, run it on its own host
  with remote storage/backups and an Alertmanager pair.
- cAdvisor and redis_exporter are optional and disabled by default.
