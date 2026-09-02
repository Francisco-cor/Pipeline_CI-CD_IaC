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
  description = "ARN of the SSM Parameter containing the DATABASE_URL. Referenced in the task definition so ECS injects it as an environment variable at container start."
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

variable "vpc_id" {
  description = "VPC ID para Cloud Map service discovery (Fase 7.6). Cuando enable_service_discovery=true crea private DNS namespace erp.local."
  type        = string
  default     = null
}

variable "enable_service_discovery" {
  description = "Fase 7.6 — crea aws_service_discovery_private_dns_namespace erp.local + services productos.erp.local:3001 etc para Fase 10 HTTP decoupling."
  type        = bool
  default     = false
}

variable "ecr_image_retention_count" {
  description = "Fase 7.5 — cuántas imágenes tagged mantener en ECR para rollback. Antes 1 era peligroso; 5 es default prod."
  type        = number
  default     = 5
}
