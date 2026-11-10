data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls images, writes logs and reads the SSM secrets for every task family.
resource "aws_iam_role" "execution" {
  name               = "acrodont-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_ssm" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = values(local.ssm_arn)
  }
}

resource "aws_iam_role_policy" "execution_ssm" {
  name   = "ssm"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_ssm.json
}

# The app task: sends mail, and nothing else.
resource "aws_iam_role" "task" {
  name               = "acrodont-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task_ses" {
  statement {
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.domain.arn]
  }
}

resource "aws_iam_role_policy" "task_ses" {
  name   = "ses"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_ses.json
}

# EventBridge Scheduler runs the backup and drill task families.
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}
