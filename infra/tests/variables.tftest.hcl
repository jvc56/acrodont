# Offline: a mock provider, no credentials. Each refused case is a value AWS
# would otherwise refuse half-way through an apply (BIRDTEST_LESSONS_PLAN.md
# SEC-3). Run with `terraform -chdir=infra test` (make infra-validate).

mock_provider "aws" {
  # Policy documents are computed locally by the real provider; a mock would
  # return a random string, which the roles refuse as JSON.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  # Computed by AWS at apply; the ops task's policy and environment need it.
  override_resource {
    target = aws_db_instance.main
    values = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-x", kms_key_id = "", secret_status = "active" }] }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
}

mock_provider "aws" {
  alias = "backup"
}

variables {
  domain_name = "acrodont.example.org"
  alarm_email = "ops@example.org"
  image_tag   = "0123456789ab"
}

run "defaults_plan" {
  command = plan
  assert {
    condition     = aws_ecs_task_definition.app.cpu == "512" && aws_ecs_task_definition.app.memory == "2048"
    error_message = "the app task's default size changed"
  }
  assert {
    condition     = aws_ecs_service.app.deployment_minimum_healthy_percent == 100 && aws_ecs_service.app.deployment_maximum_percent == 200
    error_message = "deploys must roll: the new task serves before the old one drains"
  }
  assert {
    condition     = one(aws_ecs_service.app.capacity_provider_strategy).capacity_provider == "FARGATE_SPOT"
    error_message = "the app runs on Spot by default"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.down) == 1 && length(aws_cloudwatch_metric_alarm.app_5xx) == 1
    error_message = "a running service has its down alarm and its application 5xx alarm"
  }
  assert {
    condition     = length(aws_lb_listener_rule.www) == 0
    error_message = "www is answered only when redirect_www asks for it"
  }
  assert {
    condition     = aws_db_instance.main.backup_retention_period == 7 && aws_db_instance.main.allocated_storage == 20
    error_message = "the database defaults changed"
  }
  assert {
    condition     = one(aws_lb_target_group.web.health_check).interval * one(aws_lb_target_group.web.health_check).unhealthy_threshold >= 300
    error_message = "the target group's health check must ride out a five-minute database restart before the task is replaced"
  }
  assert {
    condition     = local.backend_health_check.interval * local.backend_health_check.retries >= 300
    error_message = "the backend container's health check must ride out the same five minutes: ECS replaces a task whose container is unhealthy whatever the target group says"
  }
  assert {
    condition     = jsonencode(local.task_failed_any_of) == "[{\"containers\":{\"exitCode\":[{\"anything-but\":0}]}},{\"stopCode\":[\"TaskFailedToStart\"]}]"
    error_message = "the backup and drill failure rules changed: change task_pattern in scripts/lib/ops_fakes.py with them, which scripts/check-alerts.sh is checked against"
  }
  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.backups.rule : length(r.abort_incomplete_multipart_upload) == 1])
    error_message = "the backups bucket must abort unfinished multipart uploads"
  }
}

run "www_redirects_to_the_bare_domain" {
  command = plan
  variables {
    redirect_www = true
  }
  assert {
    condition     = contains(aws_acm_certificate.site.subject_alternative_names, "www.acrodont.example.org")
    error_message = "redirect_www must put www on the certificate"
  }
  assert {
    condition = length(aws_lb_listener_rule.www) == 2 && alltrue([
      for r in aws_lb_listener_rule.www :
      one(one(r.action).redirect).host == "acrodont.example.org" && one(one(r.action).redirect).status_code == "HTTP_301"
      && contains(one(one(r.condition).host_header).values, "www.acrodont.example.org")
    ])
    error_message = "redirect_www must answer www on both listeners with a 301 to the bare domain"
  }
}

run "on_demand_and_no_tasks" {
  command = plan
  variables {
    use_fargate_spot = false
    desired_count    = 0
  }
  assert {
    condition     = one(aws_ecs_service.app.capacity_provider_strategy).capacity_provider == "FARGATE"
    error_message = "use_fargate_spot = false must use on-demand Fargate"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.down) == 0 && length(aws_cloudwatch_metric_alarm.backend_memory_high) == 0 && length(aws_cloudwatch_metric_alarm.app_5xx) == 0
    error_message = "a stack with no tasks must not page"
  }
}

run "larger_task_and_tag_scoped_costs" {
  command = plan
  variables {
    task_cpu    = 1024
    task_memory = 4096
    cost_scope  = "tag"
  }
  assert {
    condition     = aws_ce_anomaly_monitor.acrodont[0].monitor_type == "CUSTOM"
    error_message = "tag-scoped costs need a custom monitor"
  }
}

run "existing_anomaly_monitor" {
  command = plan
  variables {
    anomaly_monitor_arn = "arn:aws:ce::123456789012:anomalymonitor/abc"
  }
  assert {
    condition     = length(aws_ce_anomaly_monitor.acrodont) == 0
    error_message = "an existing monitor must not be duplicated (one services monitor per account)"
  }
}

run "refuses_fargate_pair" {
  command = plan
  variables {
    task_cpu    = 512
    task_memory = 8192
  }
  expect_failures = [var.task_memory]
}

run "refuses_fargate_cpu" {
  command = plan
  variables {
    task_cpu = 768
  }
  expect_failures = [var.task_cpu]
}

run "refuses_same_backup_region" {
  command = plan
  variables {
    backup_region = "us-east-1"
  }
  expect_failures = [var.backup_region]
}

run "refuses_small_database" {
  command = plan
  variables {
    db_allocated_storage = 10
  }
  expect_failures = [var.db_allocated_storage]
}

run "refuses_pitr_off" {
  command = plan
  variables {
    db_backup_retention_days = 0
  }
  expect_failures = [var.db_backup_retention_days]
}

run "refuses_three_tasks" {
  command = plan
  variables {
    desired_count = 3
  }
  expect_failures = [var.desired_count]
}

run "refuses_bad_alarm_email" {
  command = plan
  variables {
    alarm_email = "ops@example.org, other@example.org"
  }
  expect_failures = [var.alarm_email]
}

run "refuses_placeholder_domain" {
  command = plan
  variables {
    domain_name = "acrodont.example"
  }
  expect_failures = [var.domain_name]
}

run "refuses_url_as_domain" {
  command = plan
  variables {
    domain_name = "https://acrodont.example.org"
  }
  expect_failures = [var.domain_name]
}

run "refuses_ops_tag" {
  command = plan
  variables {
    image_tag = "0123456789ab-ops"
  }
  expect_failures = [var.image_tag]
}

run "refuses_long_start_period" {
  command = plan
  variables {
    health_check_start_period = 400
  }
  expect_failures = [var.health_check_start_period]
}

run "refuses_fractional_mail_rate" {
  command = plan
  variables {
    mail_max_per_second = 1.5
  }
  expect_failures = [var.mail_max_per_second]
}

run "refuses_unknown_cost_scope" {
  command = plan
  variables {
    cost_scope = "project"
  }
  expect_failures = [var.cost_scope]
}
