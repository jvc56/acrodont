# Backups (PLAN.md § Backups). RDS point-in-time recovery is in rds.tf; this
# is the nightly dump (scripts/backup.py) into an encrypted, versioned,
# object-locked bucket in a second region, and the monthly restore drill
# (scripts/drill.py), which restores the newest dump into a Postgres inside its
# own task, never touching production. Both run on the ops image.
# Daily dumps are kept 90 days, monthly dumps a year.

provider "aws" {
  alias  = "backup"
  region = var.backup_region
  default_tags {
    tags = { Project = "acrodont", Environment = var.environment }
  }
}

resource "aws_s3_bucket" "backups" {
  provider            = aws.backup
  bucket              = "acrodont-${var.environment}-backups-${data.aws_caller_identity.current.account_id}"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "backups" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Neither a mistake nor a compromised role can remove a dump early: no role
# has s3:BypassGovernanceRetention, and each key is named for its day.
resource "aws_s3_bucket_object_lock_configuration" "backups" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backups.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 90
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  provider                = aws.backup
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "backups_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  provider   = aws.backup
  bucket     = aws_s3_bucket.backups.id
  policy     = data.aws_iam_policy_document.backups_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backups.id
  rule {
    id     = "daily"
    status = "Enabled"
    filter {
      prefix = "daily/"
    }
    expiration {
      days = 91
    }
    noncurrent_version_expiration {
      noncurrent_days = 91
    }
  }
  rule {
    id     = "monthly"
    status = "Enabled"
    filter {
      prefix = "monthly/"
    }
    expiration {
      days = 366
    }
    noncurrent_version_expiration {
      noncurrent_days = 366
    }
  }
  # A backup task killed mid-upload leaves its parts, which no listing shows
  # and no expiration above reaches: they would be billed for good.
  rule {
    id     = "unfinished-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

# The backup role writes (reading only the daily dump it copies to monthly/)
# and the drill role only reads, so neither can both read the archive and
# replace it.
resource "aws_iam_role" "backup_task" {
  name               = "acrodont-backup-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "backup_task" {
  statement {
    actions   = ["s3:PutObject", "s3:PutObjectRetention", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  # The first of the month's dump is copied to monthly/, which reads it.
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/daily/*"]
  }
  # Sizes the previous dump for DumpSizeRatio from the listing.
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Acrodont/Backups"]
    }
  }
}

resource "aws_iam_role_policy" "backup_task" {
  name   = "backup"
  role   = aws_iam_role.backup_task.id
  policy = data.aws_iam_policy_document.backup_task.json
}

resource "aws_iam_role" "drill_task" {
  name               = "acrodont-drill-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "drill_task" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Acrodont/Backups"]
    }
  }
}

resource "aws_iam_role_policy" "drill_task" {
  name   = "drill"
  role   = aws_iam_role.drill_task.id
  policy = data.aws_iam_policy_document.drill_task.json
}

resource "aws_ecs_task_definition" "backup" {
  family                   = "acrodont-backup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backup_task.arn

  container_definitions = jsonencode([
    {
      name       = "backup"
      image      = local.ops_image
      essential  = true
      entryPoint = ["python3", "/opt/acrodont/scripts/backup.py"]
      command = [
        "--s3-bucket", aws_s3_bucket.backups.bucket,
        "--s3-region", var.backup_region,
        "--metrics-region", var.region,
      ]
      secrets          = [{ name = "DATABASE_URL", valueFrom = local.ssm_arn["BACKUP_DATABASE_URL"] }]
      logConfiguration = merge(local.log_config, { options = merge(local.log_config.options, { awslogs-stream-prefix = "backup" }) })
    },
  ])
}

# Postgres runs inside this task, so it needs room for a dump and its restore.
resource "aws_ecs_task_definition" "drill" {
  family                   = "acrodont-drill"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.drill_task.arn
  ephemeral_storage {
    size_in_gib = 30
  }

  container_definitions = jsonencode([
    {
      name       = "drill"
      image      = local.ops_image
      essential  = true
      entryPoint = ["python3", "/opt/acrodont/scripts/drill.py"]
      command = [
        "--s3-bucket", aws_s3_bucket.backups.bucket,
        "--s3-region", var.backup_region,
        "--metrics-region", var.region,
      ]
      logConfiguration = merge(local.log_config, { options = merge(local.log_config.options, { awslogs-stream-prefix = "drill" }) })
    },
  ])
}

resource "aws_iam_role" "scheduler" {
  name               = "acrodont-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions = ["ecs:RunTask"]
    resources = [
      aws_ecs_task_definition.backup.arn_without_revision, "${aws_ecs_task_definition.backup.arn_without_revision}:*",
      aws_ecs_task_definition.drill.arn_without_revision, "${aws_ecs_task_definition.drill.arn_without_revision}:*",
    ]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.backup_task.arn, aws_iam_role.drill_task.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-scheduled-tasks"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

locals {
  schedules = {
    # Nightly dump; RDS's own backup window is 07:00.
    backup = { expression = "cron(15 3 * * ? *)", task = aws_ecs_task_definition.backup }
    # Monthly drill, on the 1st, after that night's dump.
    drill = { expression = "cron(0 5 1 * ? *)", task = aws_ecs_task_definition.drill }
  }
}

resource "aws_scheduler_schedule" "tasks" {
  for_each                     = local.schedules
  name                         = "acrodont-${each.key}"
  schedule_expression          = each.value.expression
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      # The revision Terraform registered: Terraform deploys every image.
      task_definition_arn = each.value.task.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = local.task_network.subnets
        security_groups  = local.task_network.security_groups
        assign_public_ip = true
      }
    }
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# A backup or drill task that exits non-zero, or never starts, mails within
# minutes, rather than leaving it to the 36-hour staleness alarm (BAK-2). A
# task that cannot pull its image or read its secret stops with no exit code
# at all, which "anything-but 0" does not match: hence the second branch.
resource "aws_cloudwatch_event_rule" "task_failed" {
  for_each    = { backup = "acrodont-backup", drill = "acrodont-drill" }
  name        = "acrodont-${each.key}-failed"
  description = "The ${each.key} task stopped with a non-zero exit code, or failed to start"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      group      = ["family:${each.value}"]
      lastStatus = ["STOPPED"]
      "$or"      = local.task_failed_any_of
    }
  })
}

# What makes a stopped task a failed one. A local so that the offline test can
# pin it (the pattern holds the cluster's ARN, unknown at plan):
# scripts/lib/ops_fakes.py's task_pattern is the same pattern by hand, and
# scripts/check-alerts.sh is checked against that copy.
locals {
  task_failed_any_of = [
    { containers = { exitCode = [{ "anything-but" = 0 }] } },
    { stopCode = ["TaskFailedToStart"] },
  ]
}

resource "aws_cloudwatch_event_target" "task_failed" {
  for_each  = aws_cloudwatch_event_rule.task_failed
  rule      = each.value.name
  target_id = "sns"
  arn       = aws_sns_topic.alarms.arn
  input_transformer {
    input_paths    = { task = "$.detail.taskArn", reason = "$.detail.stoppedReason" }
    input_template = "\"acrodont ${each.key} task FAILED (<task>): <reason>. Its log stream is ${each.key}/${each.key}/<task id> in ${aws_cloudwatch_log_group.app.name}.\""
  }
}
