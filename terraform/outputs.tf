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

output "ecs_cluster_name" {
  description = "Name of the ECS cluster. Used by CI/CD to trigger rolling deployments (aws ecs update-service)."
  value       = module.compute.ecs_cluster_name
}

output "ecs_service_name" {
  description = "ECS service name for deploy commands."
  value       = module.compute.ecs_service_name
}

output "ecr_repositories" {
  description = "Map of service → ECR repository URL. Used by deploy.sh: docker push <ecr_repositories[service]>:<tag>"
  value       = module.compute.ecr_repositories
}

output "log_group_name" {
  description = "CloudWatch log group for ECS container logs. View with: aws logs tail <name> --follow"
  value       = module.compute.log_group_name
}

output "alb_dns_name" {
  description = "Fase 10.4 — ALB DNS when enable_alb=true"
  value       = module.compute.alb_dns_name
}

output "sqs_queue_url" {
  description = "Fase 10.6 — SQS queue URL when enable_sqs=true"
  value       = try(aws_sqs_queue.ordenes[0].url, "")
}

output "redis_endpoint" {
  description = "Fase 10.5 — Redis endpoint when enable_redis=true"
  value       = try(aws_elasticache_cluster.redis[0].cache_nodes[0].address, "")
}
