# Thirty days: enough to investigate an incident, and the logs hold usernames
# and addresses of requests, which need not be kept longer.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/wordfall/${var.environment}"
  retention_in_days = 30
}
