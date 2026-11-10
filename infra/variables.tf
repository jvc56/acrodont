# Inputs. Each validation refuses at plan a value AWS would otherwise refuse
# half-way through an apply (BIRDTEST_LESSONS_PLAN.md SEC-3); tests/ pins them.

variable "region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region name, such as us-east-1."
  }
}

variable "backup_region" {
  description = "A second region for the nightly dumps (PLAN.md § Backups)."
  type        = string
  default     = "us-west-2"
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.backup_region))
    error_message = "backup_region must be an AWS region name, such as us-west-2."
  }
  validation {
    condition     = var.backup_region != var.region
    error_message = "backup_region must differ from region: dumps kept in their own region do not survive its loss."
  }
}

variable "environment" {
  type    = string
  default = "production"
}

variable "domain_name" {
  description = "The site's bare domain, e.g. acrodont.example.org. Used for ACM, SES and PUBLIC_URL."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain_name)) && !endswith(var.domain_name, ".example") && !endswith(var.domain_name, ".local")
    error_message = "domain_name must be a bare lowercase domain you own (no scheme, path or placeholder)."
  }
}

variable "mail_from" {
  description = "From address; defaults to no-reply@domain_name. SES sends only from the verified domain."
  type        = string
  default     = null
  validation {
    condition     = var.mail_from == null || can(regex("^[^@\\s]+@[^@\\s]+$", coalesce(var.mail_from, "x@y")))
    error_message = "mail_from must be one plain email address."
  }
}

variable "alarm_email" {
  description = "Where every alarm, budget and anomaly alert goes. Required: an unmonitored stack is the failure this exists to prevent. SNS sends a confirmation that must be clicked once."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s<>,;]+@[^@\\s<>,;]+\\.[^@\\s<>,;]+$", var.alarm_email))
    error_message = "alarm_email must be one plain email address."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "azs" {
  description = "Two availability zones. Unset, the region's first two that need no opt-in; pin the azs output here after the first apply, since a subnet cannot change zone."
  type        = list(string)
  default     = null
  validation {
    condition     = var.azs == null || length(coalesce(var.azs, [])) >= 2
    error_message = "azs needs at least two availability zones (the ALB and the RDS subnet group need two)."
  }
}

variable "image_tag" {
  description = "The release: the 12-character commit SHA scripts/deploy.sh built. Backend <ecr>:<tag>, ops <ecr>:<tag>-ops, frontend <ecr>:<tag>."
  type        = string
  validation {
    condition     = can(regex("^[0-9A-Za-z][0-9A-Za-z._-]{0,100}$", var.image_tag)) && !endswith(var.image_tag, "-ops")
    error_message = "image_tag is the release tag scripts/deploy.sh pushed (a commit SHA), without the -ops suffix."
  }
}

variable "task_cpu" {
  description = "The app task's CPU units. 512 measured enough for ~50 accounts (BIRDTEST_LESSONS_PLAN.md COST-1)."
  type        = number
  default     = 512
  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.task_cpu)
    error_message = "task_cpu must be a Fargate CPU size: 256, 512, 1024, 2048 or 4096."
  }
}

variable "task_memory" {
  description = "The app task's memory (MiB): the catalog's indexes plus EXPORT_CONCURRENCY exports, with headroom."
  type        = number
  default     = 2048
  validation {
    # Fargate's CPU and memory pairs; refused otherwise only by RegisterTaskDefinition, mid-apply.
    condition = (
      (var.task_cpu == 256 && contains([512, 1024, 2048], var.task_memory)) ||
      (var.task_cpu == 512 && var.task_memory >= 1024 && var.task_memory <= 4096 && var.task_memory % 1024 == 0) ||
      (var.task_cpu == 1024 && var.task_memory >= 2048 && var.task_memory <= 8192 && var.task_memory % 1024 == 0) ||
      (var.task_cpu == 2048 && var.task_memory >= 4096 && var.task_memory <= 16384 && var.task_memory % 1024 == 0) ||
      (var.task_cpu == 4096 && var.task_memory >= 8192 && var.task_memory <= 30720 && var.task_memory % 1024 == 0)
    )
    error_message = "task_memory is not a Fargate memory size for task_cpu (256: 512/1024/2048; 512: 1024-4096; 1024: 2048-8192; 2048: 4096-16384; 4096: 8192-30720; in 1024 steps)."
  }
}

variable "use_fargate_spot" {
  description = "Run the app task on Fargate Spot (~70% off). Acrodont is local-first: studying never needs the server, and sync retries, so an interruption's minute or two without the API goes unnoticed. Set false if Spot capacity ever fails to place the task."
  type        = bool
  default     = true
}

variable "desired_count" {
  description = "App tasks. 1 normally (rate limits are per task, so one task makes them exact); 0 only while the stack is first built (docs/runbook.md). Deploys still roll without a gap: the new task serves before the old one drains."
  type        = number
  default     = 1
  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 2
    error_message = "desired_count must be 0, 1 or 2."
  }
}

variable "health_check_start_period" {
  description = "Seconds the backend's container health check ignores failures while it migrates and indexes the catalog. Keep it at least twice the measured catalog load (MIG-4); Fargate's maximum is 300."
  type        = number
  default     = 240
  validation {
    condition     = var.health_check_start_period >= 30 && var.health_check_start_period <= 300
    error_message = "health_check_start_period must be 30 to 300 seconds."
  }
}

variable "search_concurrency" {
  description = "Searches at once per task (SEARCH_CONCURRENCY). One per vCPU, at least 1."
  type        = number
  default     = 1
}

variable "search_timeout_ms" {
  description = "SEARCH_TIMEOUT_MS. A fractional vCPU runs a search proportionally slower than a full core."
  type        = number
  default     = 4000
}

variable "export_concurrency" {
  description = "Server-streamed exports at once per task (EXPORT_CONCURRENCY): what bounds peak memory whatever the number of users."
  type        = number
  default     = 1
  validation {
    condition     = var.export_concurrency >= 1
    error_message = "export_concurrency must be at least 1."
  }
}

variable "max_accounts" {
  description = "MAX_ACCOUNTS: registration closes once this many accounts exist."
  type        = number
  default     = 50
}

variable "mail_max_per_second" {
  description = "MAIL_MAX_PER_SECOND: the SES account's maximum send rate. 1 in the sandbox; raise it (usually 14) once production access is granted."
  type        = number
  default     = 1
  validation {
    condition     = var.mail_max_per_second >= 1 && var.mail_max_per_second <= 1000 && floor(var.mail_max_per_second) == var.mail_max_per_second
    error_message = "mail_max_per_second must be a whole number from 1 to 1000."
  }
}

variable "min_app_version" {
  type    = number
  default = 0
}

variable "db_instance_class" {
  description = "Check orderability on the day: aws rds describe-orderable-db-instance-options --engine postgres --db-instance-class <class>."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "GiB. Autoscaling grows it up to five times this; RDS refuses less than 20."
  type        = number
  default     = 20
  validation {
    condition     = var.db_allocated_storage >= 20 && var.db_allocated_storage <= 1000
    error_message = "db_allocated_storage must be 20 to 1000 GiB (RDS refuses less than 20)."
  }
}

variable "db_backup_retention_days" {
  description = "RDS point-in-time recovery window. The nightly dumps cover anything older."
  type        = number
  default     = 7
  validation {
    # 0 would turn point-in-time recovery off and delete the automated backups.
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be 1 to 35."
  }
}

variable "db_apply_immediately" {
  description = "Apply class and storage changes at the apply rather than in the weekly maintenance window. A class change restarts the database."
  type        = bool
  default     = true
}

variable "monthly_budget_usd" {
  description = "The AWS budget. Alerts at 85% actual, 100% actual and 100% forecast."
  type        = number
  default     = 70
}

variable "cost_scope" {
  description = "\"account\": the budget covers the whole account (a dedicated account). \"tag\": only resources tagged Project=acrodont, for an account shared with other projects; activate the Project cost allocation tag in Billing first."
  type        = string
  default     = "account"
  validation {
    condition     = contains(["account", "tag"], var.cost_scope)
    error_message = "cost_scope must be account or tag."
  }
}

variable "anomaly_monitor_arn" {
  description = "An existing Cost Anomaly Detection monitor to subscribe to. With cost_scope = account and this empty, a services monitor is created; an account allows only one, so if `aws ce get-anomaly-monitors` already lists one, put its ARN here."
  type        = string
  default     = ""
}

variable "anomaly_threshold_usd" {
  description = "Alert on any cost anomaly with at least this total impact."
  type        = number
  default     = 10
}
