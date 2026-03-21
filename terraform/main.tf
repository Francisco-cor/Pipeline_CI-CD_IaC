# -----------------------------------------------------------------------------
# main.tf — Root module: composes all child modules
#
# Architecture overview (Week 1 — base infrastructure):
#
#   networking  →  VPC, subnets, IGW, route tables, security groups
#   database    →  RDS PostgreSQL + ElastiCache Redis (+ random password)
#   secrets     →  Secrets Manager secrets + IAM roles for ECS
#   compute     →  ECR repository + ECS cluster + placeholder task definition
#
# Data flow between modules:
#   networking outputs → database, secrets, compute (subnet IDs, SG IDs)
#   database outputs   → secrets (endpoints, credentials)
#   secrets outputs    → compute (IAM role ARNs, secret ARNs)
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      # Used by the database module to generate a secure RDS password
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # All resources get these tags automatically via default_tags.
  # This ensures cost allocation, ownership, and environment are always
  # traceable without having to add tags to every resource block.
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# -----------------------------------------------------------------------------
# Module: networking
# Creates the VPC, subnets, IGW, route tables, and security groups.
# All other modules depend on its outputs.
# -----------------------------------------------------------------------------
module "networking" {
  source = "./modules/networking"

  project_name       = var.project_name
  environment        = var.environment
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["${var.aws_region}a", "${var.aws_region}b"]
}

# -----------------------------------------------------------------------------
# Module: database
# Creates RDS PostgreSQL and ElastiCache Redis.
# Uses networking outputs to place resources in the correct subnets/SGs.
# -----------------------------------------------------------------------------
module "database" {
  source = "./modules/database"

  project_name = var.project_name
  environment  = var.environment
  db_name      = var.db_name
  db_username  = var.db_username

  # Security groups from networking module control inbound access
  sg_db_id    = module.networking.sg_db_id
  sg_redis_id = module.networking.sg_redis_id

  # RDS and ElastiCache are placed in the same subnets as ECS tasks.
  # sg_db / sg_redis ensure they are NOT reachable from the internet despite
  # being in public subnets (see ADR-001).
  subnet_ids = module.networking.public_subnet_ids
}

# -----------------------------------------------------------------------------
# Module: secrets
# Creates Secrets Manager secrets and the IAM roles used by ECS.
# Depends on database for actual endpoint/credential values to store.
# -----------------------------------------------------------------------------
module "secrets" {
  source = "./modules/secrets"

  project_name = var.project_name
  environment  = var.environment

  # Database connection details — used to build the full connection strings
  # stored in Secrets Manager so the app only needs one secret ARN.
  rds_endpoint = module.database.rds_endpoint
  rds_port     = module.database.rds_port
  rds_db_name  = module.database.rds_db_name
  rds_username = module.database.rds_username
  rds_password = module.database.rds_password

  redis_endpoint = module.database.redis_endpoint
  redis_port     = module.database.redis_port
}

# -----------------------------------------------------------------------------
# Module: compute
# Creates the ECR repository, ECS cluster, and a placeholder task definition.
# Week 2 will replace the placeholder with the real application image via CI/CD.
# -----------------------------------------------------------------------------
module "compute" {
  source = "./modules/compute"

  project_name = var.project_name
  environment  = var.environment
  app_port     = var.app_port

  # IAM roles from secrets module — ECS needs these to pull images and read secrets
  task_execution_role_arn = module.secrets.task_execution_role_arn
  task_role_arn           = module.secrets.task_role_arn

  # Secret ARNs — referenced in the task definition so ECS injects them as
  # environment variables at container startup (no secrets in task def JSON)
  db_secret_arn    = module.secrets.db_secret_arn
  redis_secret_arn = module.secrets.redis_secret_arn
  app_secret_arn   = module.secrets.app_secret_arn

  # Networking — ECS tasks run in public subnets with public IPs (see ADR-001)
  subnet_ids = module.networking.public_subnet_ids
  sg_app_id  = module.networking.sg_app_id
}
