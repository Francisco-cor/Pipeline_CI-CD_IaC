# -----------------------------------------------------------------------------
# modules/database/main.tf
#
# Creates:
#   1. random_password     — secure RDS master password (never in tfvars)
#   2. aws_db_subnet_group — RDS subnet group spanning both public subnets
#   3. aws_db_instance     — RDS PostgreSQL 15.4 (db.t3.micro, free tier)
#
# Cost decisions:
#   - multi_az = false          → avoids standby instance cost (~$15/month extra)
#   - skip_final_snapshot = true → avoids snapshot storage cost (dev only)
#   - deletion_protection = false → allows terraform destroy in dev
#
# Security note:
#   RDS is placed in public subnets (as per ADR-001) but sg_db blocks all
#   inbound traffic except from sg_app. NOT reachable from the public internet.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Random password for RDS master user
#
# WHY: Storing passwords in tfvars (even gitignored) is risky. Using
# random_password means the secret is generated on first apply, stored in
# Terraform state (encrypted at rest in S3), and then copied to Secrets
# Manager by the secrets module. No human ever sets or sees this value.
# -----------------------------------------------------------------------------
resource "random_password" "db_password" {
  length  = 32
  special = true

  # Remove @, :, /, #, and quotes that break the connection string
  override_special = "!$%^&*()-_=+[]{}|;.,<>" 
}

# -----------------------------------------------------------------------------
# DB Subnet Group
#
# RDS requires a subnet group even for single-AZ deployments. We provide both
# public subnets so that a future upgrade to multi_az = true works without
# infrastructure changes.
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name        = "${var.project_name}-${var.environment}-db-subnet-group"
  description = "RDS subnet group for ${var.project_name} ${var.environment}. Spans both public subnets; internet access blocked by sg_db."
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "${var.project_name}-${var.environment}-db-subnet-group"
  }
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL 15.4
# -----------------------------------------------------------------------------
resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${var.project_name}-${var.environment}-pg15-"
  family      = "postgres15"
  description = "ERP ${var.environment} — tuned for Fargate (log, slow query, pg_trgm)"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # ms — log queries >1s for slow query analysis
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-pg-param"
  }
}

resource "aws_db_instance" "postgres" {
  identifier = "${var.project_name}-${var.environment}-postgres"

  # Engine
  engine         = "postgres"
  engine_version = "15"
  parameter_group_name = aws_db_parameter_group.postgres.name

  # Instance sizing — db.t3.micro is covered by AWS Free Tier
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  storage_type      = "gp3" # gp3 cheaper + better baseline than gp2 (Fase 5.8)
  storage_encrypted = true

  # Credentials
  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_password.result

  # Networking
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.sg_db_id]
  publicly_accessible    = false

  # High availability — disabled for cost (no standby replica) — enable for prod
  multi_az = var.environment == "prod" ? true : false

  # Backups — Fase 5.8: prod 7d, dev/stg 1d (before 0 disabled, ahora mínimo 1 para poder restablecer)
  backup_retention_period = var.environment == "prod" ? 7 : 1
  backup_window           = "03:00-04:00"
  copy_tags_to_snapshot   = true

  # Maintenance
  maintenance_window         = "Mon:04:00-Mon:05:00"
  auto_minor_version_upgrade = true

  # Prod guards — Fase 5.8
  skip_final_snapshot       = var.environment == "prod" ? false : true
  deletion_protection       = var.environment == "prod" ? true : false
  final_snapshot_identifier = var.environment == "prod" ? "${var.project_name}-${var.environment}-final" : null

  # Performance Insights — free tier 7d, prod 731d (requires KMS if >7)
  performance_insights_enabled          = true
  performance_insights_retention_period = var.environment == "prod" ? 731 : 7

  tags = {
    Name = "${var.project_name}-${var.environment}-postgres"
  }
}

