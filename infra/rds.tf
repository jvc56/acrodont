# RDS Postgres 16, single-AZ, with storage autoscaling and a short
# point-in-time window; the nightly dumps (backups.tf) cover anything older.
resource "aws_db_subnet_group" "main" {
  name       = "acrodont"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier            = "acrodont"
  engine                = "postgres"
  engine_version        = "16"
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type          = "gp3"
  storage_encrypted     = true
  db_name               = "acrodont"
  username              = "acrodont"
  # The app and the dump connect as their own roles (acrodont_app,
  # acrodont_backup), so RDS rotating the master password every 7 days breaks
  # nothing. Ops tasks read the secret for role setup and rotation.
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  backup_retention_period     = var.db_backup_retention_days
  backup_window               = "07:00-07:30" # UTC, clear of the 03:15 dump
  maintenance_window          = "sun:08:00-sun:08:30"
  apply_immediately           = var.db_apply_immediately
  copy_tags_to_snapshot       = true
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "acrodont-final"
  auto_minor_version_upgrade  = true
}

# Storage events instead of a FreeStorageSpace threshold: under autoscaling
# free space is measured against the current allocation, so a fixed threshold
# fires after the first growth or never (birdtest). "notification" includes the
# allocation passing 80% of the autoscaling ceiling.
resource "aws_db_event_subscription" "db" {
  name             = "acrodont-db-events"
  sns_topic        = aws_sns_topic.alarms.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["low storage", "failure", "notification"]
  depends_on       = [aws_sns_topic_policy.alarms]
}
