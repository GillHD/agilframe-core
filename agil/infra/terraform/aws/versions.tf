terraform {
  # 1.9+ is required for cross-variable validation (admin_cidr guard uses
  # allow_world_admin). 1.6 features (check blocks) are kept as well.
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Local state is intentional for a reference kit. For a real customer
  # deployment switch to a locked remote backend (S3 + DynamoDB) before apply.
  # backend "s3" {}
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile != "" ? var.aws_profile : null

  default_tags {
    tags = local.tags
  }
}

check "dns_configuration" {
  assert {
    condition     = !var.create_dns_records || (var.route53_zone_id != "" && var.domain_name != "")
    error_message = "create_dns_records=true requires both route53_zone_id and domain_name."
  }
}

check "turn_ports" {
  assert {
    condition     = var.turn_relay_max_port >= var.turn_relay_min_port
    error_message = "turn_relay_max_port must be >= turn_relay_min_port."
  }
}
