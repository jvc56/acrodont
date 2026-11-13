# Alarms, all to one SNS topic mailed to alarm_email. scripts/check-alerts.sh
# proves the path works end to end (BIRDTEST_LESSONS_PLAN.md MON-1, MON-2).
# About a dozen alarms: the first ten are free, each further one ~$0.10/month.

resource "aws_sns_topic" "alarms" {
  name = "acrodont-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Who may publish: the account (the default policy's grant, which a custom
# policy replaces), CloudWatch alarms, EventBridge rules, RDS events and
# budgets, each limited to this account.
data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid     = "Owner"
    actions = ["SNS:Publish", "SNS:Subscribe", "SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:ListSubscriptionsByTopic"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    resources = [aws_sns_topic.alarms.arn]
  }
  statement {
    sid     = "Services"
    actions = ["SNS:Publish"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "events.rds.amazonaws.com", "budgets.amazonaws.com", "costalerts.amazonaws.com"]
    }
    resources = [aws_sns_topic.alarms.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

locals {
  # Alarms on a running service exist only while it is meant to run, so a
  # stack being built with desired_count = 0 does not page.
  service_alarms = var.desired_count > 0 ? 1 : 0
}

# The site is down: no healthy target for ten minutes. Ten so that a deploy,
# or a Spot interruption's replacement, never pages; OK is mailed too.
resource "aws_cloudwatch_metric_alarm" "down" {
  count               = local.service_alarms
  alarm_name          = "acrodont-down"
  alarm_description   = "acrodont has had no healthy target for ten minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { TargetGroup = aws_lb_target_group.web.arn_suffix, LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 10
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# The load balancer answering 5xx for fifteen minutes (would have caught the
# Nginx keepalive 502s, EDGE-1). No errors means no datapoints: healthy.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  count               = local.service_alarms
  alarm_name          = "acrodont-api-5xx"
  alarm_description   = "acrodont's load balancer has answered 5xx for fifteen minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# The application answering 5xx for fifteen minutes. The alarm above counts
# only what the load balancer itself answers (no target, a dropped
# connection): a backend returning 500 on every /api call while /health still
# passes is a target response, a different metric, and nothing else would say.
resource "aws_cloudwatch_metric_alarm" "app_5xx" {
  count               = local.service_alarms
  alarm_name          = "acrodont-app-5xx"
  alarm_description   = "acrodont's application has answered 5xx for fifteen minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { TargetGroup = aws_lb_target_group.web.arn_suffix, LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "backend_cpu_high" {
  count               = local.service_alarms
  alarm_name          = "acrodont-backend-cpu-high"
  alarm_description   = "acrodont's task has been over 85% CPU for fifteen minutes: look at task_cpu"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Specific to acrodont: the catalog lives in memory, so running out restarts
# the task and reloads every index.
resource "aws_cloudwatch_metric_alarm" "backend_memory_high" {
  count               = local.service_alarms
  alarm_name          = "acrodont-backend-memory-high"
  alarm_description   = "acrodont's task has been over 85% memory for ten minutes: look at task_memory and the index sizes in /admin"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# A burstable class in unlimited mode is billed for surplus rather than
# throttled, so its credit balance says little; sustained load is the signal.
resource "aws_cloudwatch_metric_alarm" "db_cpu_high" {
  alarm_name          = "acrodont-db-cpu-high"
  alarm_description   = "acrodont's database has been over 80% CPU for fifteen minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# No successful dump in 36 hours: six six-hour periods with no success,
# missing data counting as a miss. scripts/backup.py reports DumpSucceeded.
resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "acrodont-no-dump-36h"
  alarm_description   = "No successful nightly dump in 36 hours (PLAN.md § Backups)."
  namespace           = "Acrodont/Backups"
  metric_name         = "DumpSucceeded"
  statistic           = "Sum"
  period              = 21600
  evaluation_periods  = 6
  datapoints_to_alarm = 6
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# A dump more than 30% smaller than the previous one: scripts/backup.py
# reports DumpSizeRatio, this dump's bytes over the previous dump's.
resource "aws_cloudwatch_metric_alarm" "backup_shrank" {
  alarm_name          = "acrodont-dump-shrank"
  alarm_description   = "A dump more than 30% smaller than the previous one: a truncated or partial run?"
  namespace           = "Acrodont/Backups"
  metric_name         = "DumpSizeRatio"
  statistic           = "Minimum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0.7
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# Sync rejections, counted by type and reason from the backend's JSON log
# line "sync operation rejected", and graphed. Any `error` rejection alarms:
# a database error the rules did not expect.
resource "aws_cloudwatch_log_metric_filter" "sync_rejections" {
  name           = "acrodont-sync-rejections"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.fields.message = \"sync operation rejected\" }"
  metric_transformation {
    namespace = "Acrodont/Sync"
    name      = "Rejections"
    value     = "1"
    dimensions = {
      Type   = "$.fields.op_type"
      Reason = "$.fields.reason"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "sync_error_rejections" {
  name           = "acrodont-sync-error-rejections"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ ($.fields.message = \"sync operation rejected\") && ($.fields.reason = \"error\") }"
  metric_transformation {
    namespace     = "Acrodont/Sync"
    name          = "ErrorRejections"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "sync_error_rejections" {
  alarm_name          = "acrodont-sync-error-rejection"
  alarm_description   = "A sync operation was rejected as `error`: a database error the rules did not expect."
  namespace           = "Acrodont/Sync"
  metric_name         = "ErrorRejections"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# The rejection graph. stale_attempt, stale, not_active and not_deepest (and
# the not_found that can follow them) are ordinary two-device use; a rise in
# any other reason points to a divergence between the Rust and TypeScript rules.
resource "aws_cloudwatch_dashboard" "sync" {
  dashboard_name = "acrodont-sync"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 24
        height = 8
        properties = {
          title   = "Sync rejections by type and reason"
          region  = var.region
          stat    = "Sum"
          period  = 300
          metrics = [[{ expression = "SEARCH('{Acrodont/Sync,Type,Reason} MetricName=\"Rejections\"', 'Sum', 300)", id = "r" }]]
        }
      },
    ]
  })
}
