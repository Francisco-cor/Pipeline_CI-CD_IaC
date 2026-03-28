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

  # Exclude characters that cause issues in PostgreSQL connection strings
  # or shell escaping: @, /, \, ', ", `, space
  override_special = "!#$%^&*()-_=+[]{}|;:,.<>?"
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
resource "aws_db_instance" "postgres" {
  identifier = "${var.project_name}-${var.environment}-postgres"

  # Engine
  engine         = "postgres"
  engine_version = "15.4"

  # Instance sizing — db.t3.micro is covered by AWS Free Tier (750 hrs/month
  # for the first 12 months). Upgrade to db.t3.small or db.r6g.large for prod.
  instance_class    = "db.t3.micro"
  allocated_storage = 20 # GiB — minimum for gp2; also free-tier covered (20 GiB)
  storage_type      = "gp2"

  # Credentials
  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_password.result

  # Networking
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.sg_db_id]
  publicly_accessible    = false # sg_db blocks internet anyway; belt-and-suspenders

  # High availability — disabled for cost (no standby replica)
  multi_az = false

  # Backups
  backup_retention_period = 7    # days; minimum recommended even for dev
  backup_window           = "03:00-04:00" # UTC — low-traffic window

  # Maintenance
  maintenance_window          = "Mon:04:00-Mon:05:00" # UTC — after backup window
  auto_minor_version_upgrade  = true  # Apply minor patches automatically

  # Cost/dev conveniences — DO NOT use in production
  skip_final_snapshot = true  # No snapshot on destroy (saves storage cost)
  deletion_protection = false # Allow terraform destroy (enable for prod)

  # Performance Insights — free tier provides 7-day retention
  performance_insights_enabled = true

  tags = {
    Name = "${var.project_name}-${var.environment}-postgres"
  }
}

