# Optional IAM instance profile for AWS Systems Manager Session Manager.
#
# Why: the module tells operators they may leave `ssh_key_name` empty. Without
# an instance profile there is then no IAM-authenticated shell at all (P2-6).
# With enable_ssm = true (default) both core and node instances get
# AmazonSSMManagedInstanceCore, so `aws ssm start-session --target <id>` works
# without opening SSH or creating a key pair. The agent ships preinstalled on
# the Ubuntu 22.04 AMI; user_data enables it if present.
#
# Set enable_ssm = false only when you attach your own profile/role outside this
# module or have a strict IAM baseline that forbids role creation.

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ssm" {
  count = var.enable_ssm ? 1 : 0

  name               = "${local.name}-ssm"
  description        = "AGIL ${local.name} EC2 role for SSM Session Manager"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = merge(local.tags, { Name = "${local.name}-ssm" })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  count = var.enable_ssm ? 1 : 0

  role       = aws_iam_role.ssm[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  count = var.enable_ssm ? 1 : 0

  name = "${local.name}-ssm"
  role = aws_iam_role.ssm[0].name

  tags = merge(local.tags, { Name = "${local.name}-ssm" })
}
