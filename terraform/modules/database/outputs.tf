# -----------------------------------------------------------------------------
# modules/database/outputs.tf
# -----------------------------------------------------------------------------

output "rds_endpoint" {
  description = "Hostname of the RDS PostgreSQL instance (without port). Passed to the secrets module to build the full connection string."
  value       = aws_db_instance.postgres.address
}

output "rds_port" {
  description = "Port the RDS PostgreSQL instance listens on (default: 5432)."
  value       = aws_db_instance.postgres.port
}

output "rds_db_name" {
  description = "Name of the database created inside the RDS instance."
  value       = aws_db_instance.postgres.db_name
}

output "rds_username" {
  description = "Master username for the RDS PostgreSQL instance."
  value       = aws_db_instance.postgres.username
}

output "rds_password" {
  description = "Auto-generated master password for the RDS PostgreSQL instance. Marked sensitive so Terraform redacts it in plan/apply output. The secrets module stores it in SSM Parameter Store."
  value       = random_password.db_password.result
  sensitive   = true
}

output "rds_identifier" {
  description = "RDS instance identifier (DBInstanceIdentifier). Used by alarms, restore drills and runbooks to target the exact instance."
  value       = aws_db_instance.postgres.identifier
}

output "rds_arn" {
  description = "ARN of the RDS PostgreSQL instance. Used by restore drills to tag and verify the scratch copy."
  value       = aws_db_instance.postgres.arn
}

output "rds_resource_id" {
  description = "Immutable RDS resource ID (dbi-...). Stable across identifier changes and useful when correlating AWS APIs."
  value       = aws_db_instance.postgres.resource_id
}
