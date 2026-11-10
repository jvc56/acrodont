# Operator access to the database (BIRDTEST_LESSONS_PLAN.md OPS-1). RDS has no
# public address and admits only the tasks' security group, so every SQL step
# in docs/runbook.md runs from this task: the ops image (psql and pg_restore
# 16, python3, restore.py, acrodont-master-psql), the app's and the dump's
# database URLs from SSM, read access to the backups, the RDS-managed master
# secret for role setup and rotation, and ECS Exec for a shell.
# scripts/prod-sql.sh runs one batch through it; scripts/prod-shell.sh opens a
# shell. Nothing runs it on a schedule.

resource "aws_iam_role" "ops_task" {
  name               = "acrodont-ops"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "ops_task" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    actions = [
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ops_task" {
  name   = "ops"
  role   = aws_iam_role.ops_task.id
  policy = data.aws_iam_policy_document.ops_task.json
}

resource "aws_ecs_task_definition" "ops" {
  family                   = "acrodont-ops"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.ops_task.arn
  # Room for a downloaded dump and a scratch restore of it.
  ephemeral_storage {
    size_in_gib = 30
  }

  container_definitions = jsonencode([
    {
      name      = "ops"
      image     = local.ops_image
      essential = true
      # No entryPoint: each use overrides the command with ["bash", "-c", …]
      # (scripts/lib/ops.sh): psql for prod-sql.sh, sleep for prod-shell.sh.
      command = ["bash", "-c", "sleep 3600"]
      environment = [
        { name = "MASTER_SECRET_ARN", value = aws_db_instance.main.master_user_secret[0].secret_arn },
        { name = "BACKUP_BUCKET", value = aws_s3_bucket.backups.bucket },
        { name = "BACKUP_REGION", value = var.backup_region },
        { name = "AWS_REGION", value = var.region },
        { name = "AWS_DEFAULT_REGION", value = var.region },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.ssm_arn["DATABASE_URL"] },
        { name = "BACKUP_DATABASE_URL", valueFrom = local.ssm_arn["BACKUP_DATABASE_URL"] },
      ]
      logConfiguration = merge(local.log_config, { options = merge(local.log_config.options, { awslogs-stream-prefix = "ops" }) })
    },
  ])
}
