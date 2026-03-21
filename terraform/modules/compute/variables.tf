# -----------------------------------------------------------------------------
# modules/compute/variables.tf
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Project name prefix used in all resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev | staging | prod)."
  type        = string
}

variable "task_execution_role_arn" {
  description = "ARN of the IAM role that ECS assumes to pull images, write logs, and fetch secrets. Provided by the secrets module."
  type        = string
}

variable "task_role_arn" {
  description = "ARN of the IAM role assumed by the running application container. Provided by the secrets module."
  type        = string
}

variable "db_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the DATABASE_URL. Referenced in the task definition so ECS injects it as an environment variable at container start."
  type        = string
}

variable "redis_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the REDIS_URL."
  type        = string
}

variable "app_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the application JWT secret (APP_SECRET)."
  type        = string
}

variable "app_port" {
  description = "TCP port the Node.js application listens on inside the container."
  type        = number
  default     = 3000
}

variable "subnet_ids" {
  description = "List of subnet IDs where ECS tasks will run. These are public subnets (see ADR-001)."
  type        = list(string)
}

variable "sg_app_id" {
  description = "ID of the security group to attach to ECS tasks. Should allow inbound 80/443 and all outbound."
  type        = string
}
