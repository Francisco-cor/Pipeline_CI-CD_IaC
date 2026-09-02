# -----------------------------------------------------------------------------
# modules/networking/variables.tf
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Project name prefix used in all resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev | staging | prod)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Must not overlap with other VPCs if VPC peering is planned."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of Availability Zones to create public subnets in. Provide at least two for subnet group compatibility with RDS and ElastiCache (both require a subnet group spanning >= 2 AZs)."
  type        = list(string)
  default     = ["us-east-2a", "us-east-2b"]
}

variable "enable_nat_gateway" {
  description = "Fase 7.3 — toggle NAT Gateway + private subnets. False mantiene FinOps $0 (solo public). True crea private subnets + NAT + EIP para futura migración a private ECS + ALB (Fase 10). Coste ~$32/mes si true."
  type        = bool
  default     = false
}
