# Security groups. The core VM is reached only through the reverse proxy
# (80/443); the app port stays closed to the internet. Node VMs expose TURN and
# optionally SFU media ports. All rules are IPv4 for a predictable reference.
#
# AWS security groups are stateful, so return traffic needs no ingress rule.
# Replace 0.0.0.0/0 with your CDN/WAF ranges when you put one in front.

resource "aws_security_group" "core" {
  name        = "${local.name}-core"
  description = "AGIL core: 80/443 public proxy, SSH/app only from admin_cidr"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${local.name}-core", Role = "core" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "core_web" {
  for_each = var.public_web_enabled ? toset(["80", "443"]) : toset([])

  security_group_id = aws_security_group.core.id
  description       = "public HTTP(S) for the TLS reverse proxy / ACME"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "core_ssh" {
  count = var.ssh_enabled ? 1 : 0

  security_group_id = aws_security_group.core.id
  description       = "SSH from the admin CIDR only"
  ip_protocol       = "tcp"
  from_port         = var.ssh_port
  to_port           = var.ssh_port
  cidr_ipv4         = var.admin_cidr
}

resource "aws_vpc_security_group_ingress_rule" "core_app_admin" {
  security_group_id = aws_security_group.core.id
  description       = "AGIL core API from the admin CIDR (smoke/doctor)"
  ip_protocol       = "tcp"
  from_port         = var.core_http_port
  to_port           = var.core_http_port
  cidr_ipv4         = var.admin_cidr
}

resource "aws_vpc_security_group_ingress_rule" "core_from_node" {
  count = var.node_count > 0 ? 1 : 0

  security_group_id            = aws_security_group.core.id
  description                  = "Node agent -> core enrollment/heartbeat"
  ip_protocol                  = "tcp"
  from_port                    = var.core_http_port
  to_port                      = var.core_http_port
  referenced_security_group_id = aws_security_group.node[0].id
}

resource "aws_vpc_security_group_egress_rule" "core_all" {
  security_group_id = aws_security_group.core.id
  description       = "Outbound: image pulls, ACME, webhooks, SMTP"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- node (TURN and optional SFU) -----------------------------------------

resource "aws_security_group" "node" {
  count = var.node_count > 0 ? 1 : 0

  name        = "${local.name}-node"
  description = "AGIL TURN/SFU node: TURN signalling + media relay, SSH from admin"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${local.name}-node", Role = "node" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "node_ssh" {
  count = var.node_count > 0 && var.ssh_enabled ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "SSH from the admin CIDR only"
  ip_protocol       = "tcp"
  from_port         = var.ssh_port
  to_port           = var.ssh_port
  cidr_ipv4         = var.admin_cidr
}

resource "aws_vpc_security_group_ingress_rule" "node_turn_tcp" {
  count = var.node_count > 0 ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "TURN over TCP (fallback for UDP-blocked networks)"
  ip_protocol       = "tcp"
  from_port         = var.turn_port
  to_port           = var.turn_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_turn_udp" {
  count = var.node_count > 0 ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "STUN/TURN over UDP"
  ip_protocol       = "udp"
  from_port         = var.turn_port
  to_port           = var.turn_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_turn_tls" {
  count = var.node_count > 0 && var.enable_turn_tls ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "TURN over TLS (turns:5349), only when enable_turn_tls = true"
  ip_protocol       = "tcp"
  from_port         = var.turn_tls_port
  to_port           = var.turn_tls_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_turn_relay" {
  count = var.node_count > 0 ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "coturn relay range (media)"
  ip_protocol       = "udp"
  from_port         = var.turn_relay_min_port
  to_port           = var.turn_relay_max_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_sfu_http" {
  for_each = var.node_count > 0 && var.enable_sfu_ports ? toset(["http", "rtc-tcp"]) : toset([])

  security_group_id = aws_security_group.node[0].id
  description       = each.value == "http" ? "LiveKit HTTP/WebSocket signalling" : "LiveKit RTC over TCP"
  ip_protocol       = "tcp"
  from_port         = each.value == "http" ? var.sfu_http_port : var.sfu_rtc_tcp_port
  to_port           = each.value == "http" ? var.sfu_http_port : var.sfu_rtc_tcp_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_sfu_udp" {
  count = var.node_count > 0 && var.enable_sfu_ports ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "LiveKit RTC media over UDP"
  ip_protocol       = "udp"
  from_port         = var.sfu_udp_min_port
  to_port           = var.sfu_udp_max_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "node_all" {
  count = var.node_count > 0 ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  description       = "Outbound: image pulls, TURN relay to peers, core API"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
