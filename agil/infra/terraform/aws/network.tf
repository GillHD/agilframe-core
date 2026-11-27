data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.project_name}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, length(var.public_subnet_cidrs))

  tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Component   = "agil-infra"
    },
    var.tags,
  )

  public_origin = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.core.public_ip}"

  # Core base URLs used by remote node hosts (P2-4).
  core_public_url  = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.core.public_ip}:${var.core_http_port}"
  core_private_url = "http://${aws_instance.core.private_ip}:${var.core_http_port}"

  turn_fqdn = var.turn_hostname != "" ? var.turn_hostname : (var.domain_name != "" ? "turn.${var.domain_name}" : "")
  sfu_fqdn  = var.sfu_hostname != "" ? var.sfu_hostname : (var.domain_name != "" ? "sfu.${var.domain_name}" : "")
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = "${local.name}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${local.name}-public" })
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
