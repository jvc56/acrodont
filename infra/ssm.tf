# Secret configuration, referenced by ARN only. Declared as aws_ssm_parameter
# resources (even with ignore_changes = [value]) the provider reads each value,
# decrypted, into state on every refresh (BIRDTEST_LESSONS_PLAN.md SEC-1). The
# parameters are created out of band by scripts/init-db-roles.sh.
locals {
  ssm_prefix = "/wordfall/${var.environment}"
  ssm_arn = {
    for name in ["DATABASE_URL", "SESSION_SIGNING_KEY", "BACKUP_DATABASE_URL"] :
    name => "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/${name}"
  }
}
