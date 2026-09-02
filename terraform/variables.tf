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

# -----------------------------------------------------------------------------
# Fase 7 — Prod guards & FinOps toggles
# -----------------------------------------------------------------------------

variable "enable_nat_gateway" {
  description = "Create NAT Gateway + private subnets for prod-grade isolation. False keeps FinOps $0 (public subnets only, ADR-001). Toggle true when enable_alb=true (Fase 10)."
  type        = bool
  default     = false
}

variable "enable_deletion_protection" {
  description = "Override deletion_protection for RDS. Null = auto (true en prod, false en dev/staging). True impide terraform destroy sin desactivar primero."
  type        = bool
  default     = null
}

variable "enable_service_discovery" {
  description = "Create Cloud Map private DNS namespace erp.local for service-to-service HTTP (productos.erp.local). Prepares Fase 10 decoupling."
  type        = bool
  default     = false
}

variable "ecr_image_retention_count" {
  description = "Number of tagged ECR images to keep for rollback (Fase 7.5). Antes 1 era peligroso; 5 permite rollback a 4 versiones previas."
  type        = number
  default     = 5

  validation {
    condition     = var.ecr_image_retention_count >= 1 && var.ecr_image_retention_count <= 20
    error_message = "ecr_image_retention_count must be 1..20."
  }
}

# -----------------------------------------------------------------------------
# Fase 10 — Scale & Resilience toggles (FinOps $0 by default, prod toggle)
# -----------------------------------------------------------------------------
variable "enable_alb" {
  description = "Fase 10.4 — Create ALB + target group + listener (cost ~$16/mo). False = nginx sidecar FinOps, true = ALB front. Requiere enable_nat_gateway=true para ECS private subnets recomendado."
  type        = bool
  default     = false
}

variable "acm_certificate_arn" {
  description = "Fase 10.4 — ACM certificate ARN para HTTPS listener (443). Vacio = solo HTTP 80. Setear cuando enable_alb=true y dominio configurado."
  type        = string
  default     = ""
}

variable "enable_autoscaling" {
  description = "Fase 10.3 — Habilita App Auto Scaling target tracking CPU 70% (y opcional ALB request count). False mantiene desired_count=1 FinOps; true escala 1-4."
  type        = bool
  default     = false
}

variable "autoscaling_min_capacity" {
  description = "Fase 10.3 — min tasks cuando autoscaling habilitado."
  type        = number
  default     = 1
}

variable "autoscaling_max_capacity" {
  description = "Fase 10.3 — max tasks cuando autoscaling habilitado."
  type        = number
  default     = 4
}

variable "enable_redis" {
  description = "Fase 10.5 — Crea ElastiCache Redis (cache.t3.micro) en private subnets para productos list cache. False = memory fallback local (docker-compose redis). True coste ~$12/mo."
  type        = bool
  default     = false
}

variable "enable_sqs" {
  description = "Fase 10.6 — Crea SQS queue para ordenes→stock async (orden.creada). False = log noop, true crea queue + DLQ. Coste $0.40/millón."
  type        = bool
  default     = false
}
