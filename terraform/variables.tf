# -----------------------------------------------------------------------------
# variables.tf — Root-level input variables
#
# Sensitive values (passwords, secrets) are NEVER defined here. They are
# generated at apply time (random_password) or injected via CI/CD pipeline.
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Short name for the project; used as a prefix for all AWS resource names to ensure uniqueness across environments."
  type        = string
  default     = "erp-pipeline"
}

variable "environment" {
  description = "Deployment environment (dev | staging | prod). Controls naming conventions and enables environment-specific safety guards (e.g., deletion protection in prod)."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region where all resources will be deployed."
  type        = string
  default     = "us-east-2"
}

variable "db_name" {
  description = "Name of the PostgreSQL database to create inside the RDS instance."
  type        = string
  default     = "erpdb"
}

variable "db_username" {
  description = "Master username for the RDS PostgreSQL instance. The password is generated automatically by the database module (random_password) and stored in Secrets Manager — it is never set as a plain Terraform variable."
  type        = string
  default     = "erpadmin"
}

variable "app_port" {
  description = "TCP port the Node.js application listens on inside the container."
  type        = number
  default     = 3000
}

variable "github_repo" {
  description = "GitHub repository in owner/name format (e.g. 'acme/erp-pipeline'). Used in the OIDC trust policy to scope which repository can assume the GitHub Actions IAM role."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Email address for CloudWatch alarm SNS notifications. Leave empty to create the SNS topic without a subscription (you can add one manually later). AWS sends a confirmation email that must be clicked before alerts are delivered."
  type        = string
  default     = ""
}
