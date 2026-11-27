# Optional Route53 records. TLS is intentionally NOT provisioned here:
# terminate TLS at Caddy/nginx/HAProxy on the core host (Let's Encrypt) or at an
# ALB with an ACM certificate. See README.md "TLS options".

locals {
  dns_ready = var.create_dns_records && var.route53_zone_id != "" && var.domain_name != ""
}

resource "aws_route53_record" "core" {
  count = local.dns_ready ? 1 : 0

  zone_id         = var.route53_zone_id
  name            = var.domain_name
  type            = "A"
  ttl             = 300
  records         = [aws_eip.core.public_ip]
  allow_overwrite = true
}

resource "aws_route53_record" "turn" {
  count = local.dns_ready && var.node_count > 0 ? 1 : 0

  zone_id         = var.route53_zone_id
  name            = local.turn_fqdn
  type            = "A"
  ttl             = 60
  records         = [aws_eip.node[0].public_ip]
  allow_overwrite = true
}

resource "aws_route53_record" "sfu" {
  count = local.dns_ready && var.node_count > 0 && var.enable_sfu_ports ? 1 : 0

  zone_id         = var.route53_zone_id
  name            = local.sfu_fqdn
  type            = "A"
  ttl             = 60
  records         = aws_eip.node[*].public_ip
  allow_overwrite = true
}

resource "aws_route53_record" "node" {
  count = local.dns_ready ? var.node_count : 0

  zone_id         = var.route53_zone_id
  name            = "node-${count.index + 1}.${var.domain_name}"
  type            = "A"
  ttl             = 60
  records         = [aws_eip.node[count.index].public_ip]
  allow_overwrite = true
}
