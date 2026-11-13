# Read by scripts/lib/ops.sh; keep the names in step with it.
output "region" { value = var.region }
output "site_host" { value = var.domain_name }
output "azs" {
  description = "Pin into prod.tfvars after the first apply."
  value       = local.azs
}
output "cluster_name" { value = aws_ecs_cluster.main.name }
output "service_name" { value = aws_ecs_service.app.name }
output "task_subnets" { value = aws_subnet.public[*].id }
output "task_security_group" { value = aws_security_group.tasks.id }
output "ops_task_family" { value = aws_ecs_task_definition.ops.family }
output "log_group" { value = aws_cloudwatch_log_group.app.name }
output "target_group_arn" { value = aws_lb_target_group.web.arn }
output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
output "ecr_backend" { value = aws_ecr_repository.backend.repository_url }
output "ecr_frontend" { value = aws_ecr_repository.frontend.repository_url }
output "db_identifier" { value = aws_db_instance.main.identifier }
output "db_endpoint" { value = aws_db_instance.main.address }
output "backups_bucket" { value = aws_s3_bucket.backups.bucket }
output "alb_dns_name" { value = aws_lb.main.dns_name }

output "acm_validation_records" {
  description = "Create these DNS records out of band to validate the certificate: one for the domain, and with redirect_www one for www."
  value = [for o in aws_acm_certificate.site.domain_validation_options : {
    name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value
  }]
}

output "ses_dns_records" {
  description = "DKIM, MAIL FROM and DMARC records for the domain (docs/runbook.md, One-time setup)."
  value = concat(
    [for t in flatten(aws_sesv2_email_identity.domain.dkim_signing_attributes[*].tokens) : {
      name = "${t}._domainkey.${var.domain_name}", type = "CNAME", value = "${t}.dkim.amazonses.com"
    }],
    [
      { name = "mail.${var.domain_name}", type = "MX", value = "10 feedback-smtp.${var.region}.amazonses.com" },
      { name = "mail.${var.domain_name}", type = "TXT", value = "v=spf1 include:amazonses.com ~all" },
      { name = "_dmarc.${var.domain_name}", type = "TXT", value = "v=DMARC1; p=none; rua=mailto:${var.alarm_email}" },
    ],
  )
}
