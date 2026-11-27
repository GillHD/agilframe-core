# Inputs for the AGIL AWS reference deployment. No secrets belong here:
# SSH keys are referenced by name, TURN/API secrets are generated on the host
# by agil/infra/quickstart/install.sh or a secret manager.

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Optional shared AWS CLI profile. Empty = environment/default chain."
  type        = string
  default     = ""
}

variable "project_name" {
  description = "Name prefix for resources."
  type        = string
  default     = "agil"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project_name))
    error_message = "project_name must be 2-21 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "environment" {
  description = "Environment suffix (demo, staging, prod)."
  type        = string
  default     = "demo"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,12}$", var.environment))
    error_message = "environment must be lowercase letters, digits or dashes."
  }
}

# --- network ---------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the reference VPC."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR."
  }
}

variable "public_subnet_cidrs" {
  description = "Two public subnet CIDRs (one per AZ). Instances get public IPs because WebRTC media and TURN need them."
  type        = list(string)
  default     = ["10.40.10.0/24", "10.40.20.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2 && alltrue([for cidr in var.public_subnet_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Provide exactly two valid subnet CIDRs."
  }
}

# --- access ----------------------------------------------------------------

variable "admin_cidr" {
  description = "Your office/home/CI egress CIDR for SSH and the core port. Never 0.0.0.0/0 for SSH."
  type        = string

  validation {
    # Terraform >= 1.9 lets a validation refer to another input variable. This
    # rejects a /0 route (0.0.0.0/0 or ::/0) unless the operator explicitly opts
    # into a world-open demo with allow_world_admin = true.
    condition = can(cidrhost(var.admin_cidr, 0)) && (
      var.allow_world_admin || try(tonumber(split("/", var.admin_cidr)[1]), -1) > 0
    )
    error_message = "admin_cidr must be a valid CIDR and must not be a /0 route (0.0.0.0/0 or ::/0). Set allow_world_admin = true only for a throwaway demo."
  }
}

variable "allow_world_admin" {
  description = "Escape hatch for admin_cidr=0.0.0.0/0 (throwaway/demo only; exposes SSH and the core port to the internet)."
  type        = bool
  default     = false
}

variable "ssh_enabled" {
  description = "Open SSH (var.ssh_port) from admin_cidr on all instances."
  type        = bool
  default     = true
}

variable "ssh_port" {
  description = "SSH port (change only if your AMI/host is preconfigured)."
  type        = number
  default     = 22

  validation {
    condition     = var.ssh_port > 0 && var.ssh_port <= 65535
    error_message = "ssh_port must be 1..65535."
  }
}

variable "ssh_key_name" {
  description = "Existing EC2 key pair name. Empty = no SSH key attached; use SSM Session Manager (enable_ssm=true) or the console."
  type        = string
  default     = ""
}

variable "enable_ssm" {
  description = "Create an IAM role + instance profile with AmazonSSMManagedInstanceCore and attach it to core/node VMs, so Session Manager works without SSH or a key pair."
  type        = bool
  default     = true
}

variable "public_web_enabled" {
  description = "Open 80/443 from the internet for the TLS reverse proxy / ACME."
  type        = bool
  default     = true
}

# --- compute ---------------------------------------------------------------

variable "ami_id" {
  description = "Optional AMI id override. Empty = latest Ubuntu 22.04 LTS amd64."
  type        = string
  default     = ""
}

variable "ami_name_filter" {
  description = "AMI name pattern used when ami_id is empty."
  type        = string
  default     = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
}

variable "core_instance_type" {
  description = "Core VM size. 2 vCPU / 2 GiB is the minimum; 2 vCPU / 4 GiB recommended."
  type        = string
  default     = "t3.small"
}

variable "node_count" {
  description = "Number of node VMs (TURN/SFU). 0 = core only."
  type        = number
  default     = 1

  validation {
    condition     = var.node_count >= 0 && var.node_count <= 5
    error_message = "node_count must be 0..5."
  }
}

variable "node_instance_type" {
  description = "Node VM size. TURN is bandwidth-bound; SFU is CPU-bound."
  type        = string
  default     = "t3.small"
}

variable "core_volume_size" {
  description = "Core root disk (GiB): images, .data, backups."
  type        = number
  default     = 30

  validation {
    condition     = var.core_volume_size >= 20
    error_message = "core_volume_size must be >= 20 GiB."
  }
}

variable "node_volume_size" {
  description = "Node root disk (GiB)."
  type        = number
  default     = 30

  validation {
    condition     = var.node_volume_size >= 20
    error_message = "node_volume_size must be >= 20 GiB."
  }
}

variable "volume_type" {
  description = "EBS volume type for root disks."
  type        = string
  default     = "gp3"
}

variable "enable_detailed_monitoring" {
  description = "CloudWatch detailed monitoring (1-minute metrics, extra cost)."
  type        = bool
  default     = false
}

# --- WebRTC ports ----------------------------------------------------------

variable "turn_port" {
  description = "coturn STUN/TURN listening port (TCP+UDP)."
  type        = number
  default     = 3478
}

variable "turn_tls_port" {
  description = "TURN over TLS port. The security-group rule is opened only when enable_turn_tls = true."
  type        = number
  default     = 5349
}

variable "enable_turn_tls" {
  description = "Open turn_tls_port/tcp on nodes. Enable only when coturn is configured with a certificate (the quickstart disables TURN TLS by default)."
  type        = bool
  default     = false
}

variable "turn_relay_min_port" {
  description = "Start of the coturn relay range (UDP)."
  type        = number
  default     = 49200
}

variable "turn_relay_max_port" {
  description = "End of the coturn relay range (UDP)."
  type        = number
  default     = 49250
}

variable "enable_sfu_ports" {
  description = "Open LiveKit SFU signalling/RTC ports on nodes (7880, 7881, 50000-50100/udp)."
  type        = bool
  default     = false
}

variable "sfu_http_port" {
  description = "LiveKit HTTP/WebSocket port."
  type        = number
  default     = 7880
}

variable "sfu_rtc_tcp_port" {
  description = "LiveKit RTC over TCP port."
  type        = number
  default     = 7881
}

variable "sfu_udp_min_port" {
  description = "Start of the LiveKit RTC UDP range."
  type        = number
  default     = 50000
}

variable "sfu_udp_max_port" {
  description = "End of the LiveKit RTC UDP range."
  type        = number
  default     = 50100
}

variable "core_http_port" {
  description = "AGIL core HTTP port on the VM (kept closed to the internet by default)."
  type        = number
  default     = 8787
}

# --- DNS -------------------------------------------------------------------

variable "create_dns_records" {
  description = "Create Route53 A records for the core and nodes. Requires domain_name + route53_zone_id."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Public core hostname, e.g. calls.example.com (no scheme, no trailing dot)."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$", var.domain_name))
    error_message = "domain_name must be a lowercase DNS name without scheme/path."
  }
}

variable "route53_zone_id" {
  description = "Route53 hosted zone id that contains domain_name (Z...)."
  type        = string
  default     = ""
}

variable "turn_hostname" {
  description = "Optional TURN hostname. Empty = turn.<domain_name>."
  type        = string
  default     = ""
}

variable "sfu_hostname" {
  description = "Optional SFU hostname. Empty = sfu.<domain_name>."
  type        = string
  default     = ""
}

# --- tagging ---------------------------------------------------------------

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}
