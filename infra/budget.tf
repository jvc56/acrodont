# Cost alerts in Terraform, so their settings live in the code (birdtest set
# its own by hand and by CLI). BIRDTEST_LESSONS_PLAN.md COST-5.

locals {
  cost_tag = "user:Project$wordfall"
}

resource "aws_budgets_budget" "monthly" {
  name         = "wordfall-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = var.cost_scope == "tag" ? [1] : []
    content {
      name   = "TagKeyValue"
      values = [local.cost_tag]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 85
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alarm_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alarm_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}

# AWS allows one services monitor per account, and new accounts often have
# one already: anomaly_monitor_arn names it. With cost_scope = tag, a custom
# monitor on the Project tag instead.
resource "aws_ce_anomaly_monitor" "wordfall" {
  count             = var.anomaly_monitor_arn == "" ? 1 : 0
  name              = "wordfall"
  monitor_type      = var.cost_scope == "tag" ? "CUSTOM" : "DIMENSIONAL"
  monitor_dimension = var.cost_scope == "tag" ? null : "SERVICE"
  monitor_specification = var.cost_scope == "tag" ? jsonencode({
    Tags = { Key = "Project", Values = ["wordfall"], MatchOptions = ["EQUALS"] }
  }) : null
}

resource "aws_ce_anomaly_subscription" "wordfall" {
  name             = "wordfall"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [var.anomaly_monitor_arn != "" ? var.anomaly_monitor_arn : aws_ce_anomaly_monitor.wordfall[0].arn]
  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alarms.arn
  }
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = [tostring(var.anomaly_threshold_usd)]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
  depends_on = [aws_sns_topic_policy.alarms]
}
