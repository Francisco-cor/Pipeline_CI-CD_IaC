# -----------------------------------------------------------------------------
# modules/database/variables.tf
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Project name prefix used in all resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev | staging | prod)."
  type        = string
}

variable "db_name" {
  description = "Name of the PostgreSQL database to create inside the RDS instance."
  type        = string
}

variable "db_username" {
  description = "Master username for the RDS PostgreSQL instance."
  type        = string
}

variable "sg_db_id" {
  description = "ID of the security group to attach to the RDS instance. Should only allow inbound from sg_app."
  type        = string
}

variable "sg_redis_id" {
  description = "ID of the security group to attach to the ElastiCache cluster. Should only allow inbound from sg_app."
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs for the RDS and ElastiCache subnet groups. Must span at least two AZs (AWS requirement for DB subnet groups)."
  type        = list(string)
}
