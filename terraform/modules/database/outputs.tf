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
  description = "Auto-generated master password for the RDS PostgreSQL instance. Marked sensitive so Terraform redacts it in plan/apply output. The secrets module stores this in Secrets Manager."
  value       = random_password.db_password.result
  sensitive   = true
}

output "redis_endpoint" {
  description = "Hostname of the primary ElastiCache Redis node."
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "redis_port" {
  description = "Port the ElastiCache Redis cluster listens on (default: 6379)."
  value       = aws_elasticache_cluster.redis.cache_nodes[0].port
}
