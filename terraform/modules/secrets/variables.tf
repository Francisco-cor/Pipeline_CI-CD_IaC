# -----------------------------------------------------------------------------
# modules/secrets/variables.tf
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Project name prefix used in all resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev | staging | prod)."
  type        = string
}

variable "rds_endpoint" {
  description = "Hostname of the RDS PostgreSQL instance. Used to construct the DATABASE_URL connection string."
  type        = string
}

variable "rds_port" {
  description = "Port the RDS PostgreSQL instance listens on."
  type        = number
}

variable "rds_db_name" {
  description = "Name of the PostgreSQL database."
  type        = string
}

variable "rds_username" {
  description = "Master username for the RDS PostgreSQL instance."
  type        = string
}

variable "rds_password" {
  description = "Master password for the RDS PostgreSQL instance. Marked sensitive to prevent it from appearing in plan/apply output or logs."
  type        = string
  sensitive   = true
}

variable "sqs_queue_arn" {
  description = "Optional SQS queue ARN used by the application task role. Empty when SQS is disabled."
  type        = string
  default     = ""
}

variable "ssm_kms_key_id" {
  description = "Optional customer-managed KMS key ARN used by the SSM SecureString parameter and its execution-role decrypt permission."
  type        = string
  default     = null
  nullable    = true
}
