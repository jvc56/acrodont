terraform {
  # 1.11: use_lockfile for the S3 backend's state lock (no DynamoDB table).
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
  # Configured at init by scripts/onboard-deployer.sh (-backend-config), so no
  # bucket name is committed.
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "wordfall", Environment = var.environment }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
