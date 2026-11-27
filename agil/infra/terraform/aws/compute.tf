data "aws_ami" "ubuntu" {
  count = var.ami_id == "" ? 1 : 0

  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = [var.ami_name_filter]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

locals {
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id
}

resource "aws_instance" "core" {
  ami                    = local.ami_id
  instance_type          = var.core_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.core.id]
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : null
  # SSM Session Manager works even without an SSH key (P2-6).
  iam_instance_profile = var.enable_ssm ? aws_iam_instance_profile.ssm[0].name : null

  associate_public_ip_address = true
  monitoring                  = var.enable_detailed_monitoring
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    role          = "core"
    node_name     = "${local.name}-core"
    public_origin = var.domain_name != "" ? "https://${var.domain_name}" : "http://<core-public-ip>"
    core_url      = "http://<core-private-ip>:${var.core_http_port}"
    turn_port     = var.turn_port
    turn_min      = var.turn_relay_min_port
    turn_max      = var.turn_relay_max_port
    core_port     = var.core_http_port
  })

  root_block_device {
    volume_size           = var.core_volume_size
    volume_type           = var.volume_type
    encrypted             = true
    delete_on_termination = true

    tags = merge(local.tags, { Name = "${local.name}-core-root" })
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }

  tags = merge(local.tags, { Name = "${local.name}-core", Role = "core" })

  lifecycle {
    # A newer Ubuntu AMI must not silently replace a running production host.
    ignore_changes = [ami]
  }
}

resource "aws_eip" "core" {
  domain   = "vpc"
  instance = aws_instance.core.id

  tags = merge(local.tags, { Name = "${local.name}-core-eip" })
}

resource "aws_instance" "node" {
  count = var.node_count

  ami                    = local.ami_id
  instance_type          = var.node_instance_type
  subnet_id              = aws_subnet.public[count.index % length(aws_subnet.public)].id
  vpc_security_group_ids = [aws_security_group.node[0].id]
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : null
  iam_instance_profile   = var.enable_ssm ? aws_iam_instance_profile.ssm[0].name : null

  associate_public_ip_address = true
  monitoring                  = var.enable_detailed_monitoring
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    role          = "node"
    node_name     = "${local.name}-node-${count.index + 1}"
    public_origin = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.core.public_ip}"
    # In-VPC endpoint for node registration/heartbeat (no public hairpin, and
    # the core SG already allows the node SG on core_http_port). Use the public
    # HTTPS origin instead when the node is outside this VPC.
    core_url  = "http://${aws_instance.core.private_ip}:${var.core_http_port}"
    turn_port = var.turn_port
    turn_min  = var.turn_relay_min_port
    turn_max  = var.turn_relay_max_port
    core_port = var.core_http_port
  })

  root_block_device {
    volume_size           = var.node_volume_size
    volume_type           = var.volume_type
    encrypted             = true
    delete_on_termination = true

    tags = merge(local.tags, { Name = "${local.name}-node-${count.index + 1}-root" })
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }

  tags = merge(local.tags, {
    Name = "${local.name}-node-${count.index + 1}"
    Role = "node"
  })

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "node" {
  count = var.node_count

  domain   = "vpc"
  instance = aws_instance.node[count.index].id

  tags = merge(local.tags, { Name = "${local.name}-node-${count.index + 1}-eip" })
}
