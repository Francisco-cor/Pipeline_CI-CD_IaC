# -----------------------------------------------------------------------------
# outputs.tf — Root-level outputs
#
# These values are exposed so that other tooling (CI/CD scripts, developers)
# can retrieve infrastructure details without reading state files directly.
# Run: terraform output -json  to get all values in machine-readable format.
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the VPC that hosts all project resources."
  value       = module.networking.vpc_id
}

output "public_subnet_ids" {
  description = "List of public subnet IDs (one per AZ) used by ECS tasks and the RDS subnet group."
  value       = module.networking.public_subnet_ids
}

output "rds_endpoint" {
  description = "Hostname of the RDS PostgreSQL instance. Use the full connection string from Secrets Manager (/erp/db-url) in application code — never this raw endpoint."
  value       = module.database.rds_endpoint
}

output "ecr_repository_url" {
  description = "URL of the ECR repository. Used by CI/CD to push application images: docker push <ecr_repository_url>:<git_sha>"
  value       = module.compute.ecr_repository_url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster. Used by CI/CD to trigger rolling deployments (aws ecs update-service)."
  value       = module.compute.ecs_cluster_name
}
