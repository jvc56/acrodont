# Outbound account mail: confirmation codes and reset links. DNS records are
# created wherever the domain is hosted, from the outputs.
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name
}

# A MAIL FROM subdomain aligns SPF with the domain for DMARC.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# SES pauses an account whose bounce or complaint rate stays high (reviews at
# 5% / 0.1%, may pause at 10% / 0.5%), and then every confirmation and reset
# fails while the caller sees a success. Registration mails any address a
# visitor types, so bounces are a rate a visitor can drive. Suppressed
# addresses are never mailed again; the rates alarm before SES acts; any
# failed send alarms at once (BIRDTEST_LESSONS_PLAN.md MAIL-2).
resource "aws_sesv2_account_suppression_attributes" "main" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}

resource "aws_cloudwatch_metric_alarm" "ses_reputation" {
  for_each = {
    bounce    = { metric = "Reputation.BounceRate", threshold = 0.04 }
    complaint = { metric = "Reputation.ComplaintRate", threshold = 0.0008 }
  }
  alarm_name          = "acrodont-ses-${each.key}-rate"
  alarm_description   = "SES ${each.key} rate is nearing the rate at which SES pauses sending"
  namespace           = "AWS/SES"
  metric_name         = each.value.metric
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # Published irregularly, and not at all without mail: keep the last state.
  treat_missing_data = "ignore"
  alarm_actions      = [aws_sns_topic.alarms.arn]
  ok_actions         = [aws_sns_topic.alarms.arn]
}

# Every failed send is logged with the JSON field alarm = "mail_failed"
# (backend/src/auth/mail.rs). A field, not a phrase: Nginx logs to this group
# too, with visitor-controlled User-Agents.
resource "aws_cloudwatch_log_metric_filter" "mail_failed" {
  name           = "acrodont-mail-failed"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.fields.alarm = \"mail_failed\" }"
  metric_transformation {
    name          = "MailFailed"
    namespace     = "Acrodont/Mail"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_failed" {
  alarm_name          = "acrodont-mail-failed"
  alarm_description   = "An account mail failed to send; the backend's log says why"
  namespace           = "Acrodont/Mail"
  metric_name         = "MailFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
