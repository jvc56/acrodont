# One task definition with two containers, backend and Nginx. Terraform is the
# only deployer: scripts/deploy.sh sets image_tag and applies, so the state
# always says what is running (BIRDTEST_LESSONS_PLAN.md DEP-1).
resource "aws_ecs_cluster" "main" {
  name = "wordfall"
  # Container Insights bills custom metrics; the service-level CPU and memory
  # metrics the alarms use are free without it.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  # ECS Exec (ops tasks only) is never logged: a transcript would hold what an
  # operator echoes, DATABASE_URL among it (SEC-2).
  configuration {
    execute_command_configuration {
      logging = "NONE"
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

locals {
  public_url     = "https://${var.domain_name}"
  backend_image  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
  ops_image      = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}-ops"
  frontend_image = "${aws_ecr_repository.frontend.repository_url}:${var.image_tag}"
  backend_env = {
    BIND_ADDR           = "127.0.0.1:8080"
    SECURE_COOKIES      = "true"
    MAIL_BACKEND        = "ses"
    MAIL_FROM           = coalesce(var.mail_from, "no-reply@${var.domain_name}")
    MAIL_MAX_PER_SECOND = tostring(var.mail_max_per_second)
    PUBLIC_URL          = local.public_url
    SEARCH_CONCURRENCY  = tostring(var.search_concurrency)
    SEARCH_TIMEOUT_MS   = tostring(var.search_timeout_ms)
    EXPORT_CONCURRENCY  = tostring(var.export_concurrency)
    MAX_ACCOUNTS        = tostring(var.max_accounts)
    MIN_APP_VERSION     = tostring(var.min_app_version)
    TRUSTED_PROXY_HOPS  = "1"
    AWS_REGION          = var.region
    RUST_LOG            = "info"
  }
  log_config = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.app.name
      awslogs-region        = var.region
      awslogs-stream-prefix = "wordfall"
    }
  }
  task_network = {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "wordfall"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "backend"
      image        = local.backend_image
      essential    = true
      environment  = [for k, v in local.backend_env : { name = k, value = v }]
      secrets      = [for k in ["DATABASE_URL", "SESSION_SIGNING_KEY"] : { name = k, valueFrom = local.ssm_arn[k] }]
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      # The 30 s default SIGKILLs graceful shutdown's in-flight work (a
      # streaming export, a large sync batch); 120 is Fargate's maximum.
      stopTimeout = 120
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/health || exit 1"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = var.health_check_start_period
      }
      logConfiguration = local.log_config
    },
    {
      name      = "nginx"
      image     = local.frontend_image
      essential = true
      environment = [
        { name = "BACKEND_UPSTREAM", value = "127.0.0.1:8080" },
        { name = "REAL_IP_FROM", value = var.vpc_cidr },
        { name = "HSTS", value = "max-age=31536000" },
      ]
      portMappings     = [{ containerPort = 80, protocol = "tcp" }]
      dependsOn        = [{ containerName = "backend", condition = "HEALTHY" }]
      stopTimeout      = 120
      logConfiguration = local.log_config
    },
  ])
}

resource "aws_ecs_service" "app" {
  name                              = "wordfall"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.desired_count
  health_check_grace_period_seconds = 300
  # Rolls: the new task serves before the old one drains. Wordfall runs safely
  # as two instances for that minute (advisory-locked purge, NOTIFY catalog
  # reload, no SSE), unlike birdtest's stop-first single task.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  # A release whose task cannot start rolls back instead of retrying forever;
  # the deploy_failed rule mails why (DEP-2).
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # Exec goes to ops tasks only (infra/ops.tf), never into the task serving users.
  enable_execute_command = false

  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = local.task_network.subnets
    security_groups  = local.task_network.security_groups
    assign_public_ip = local.task_network.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "nginx"
    container_port   = 80
  }

  depends_on = [aws_lb_listener.https, aws_ecs_cluster_capacity_providers.main]
}

# A deployment the circuit breaker rolled back. Terraform's state still names
# the failed release, so the next apply would deploy it again: the mail says so.
resource "aws_cloudwatch_event_rule" "deploy_failed" {
  name        = "wordfall-deploy-failed"
  description = "A wordfall deployment failed and ECS rolled it back"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Deployment State Change"]
    resources   = [aws_ecs_service.app.id]
    detail      = { eventName = ["SERVICE_DEPLOYMENT_FAILED"] }
  })
}

resource "aws_cloudwatch_event_target" "deploy_failed" {
  rule      = aws_cloudwatch_event_rule.deploy_failed.name
  target_id = "sns"
  arn       = aws_sns_topic.alarms.arn
  input_transformer {
    input_paths = {
      reason     = "$.detail.reason"
      deployment = "$.detail.deploymentId"
    }
    input_template = "\"wordfall deploy FAILED and ECS rolled back to the previous release: <reason> (<deployment>). Terraform's state still names the failed release, so run scripts/rollback.sh before any other apply (docs/runbook.md, Rolling back). The stopped tasks and the log group ${aws_cloudwatch_log_group.app.name} say what failed.\""
  }
}
