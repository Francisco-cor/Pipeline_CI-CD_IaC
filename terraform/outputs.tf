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

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC. Add as AWS_ROLE_ARN secret in GitHub repo settings."
  value       = aws_iam_role.github_actions.arn
}

output "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarm notifications."
  value       = aws_sns_topic.alerts.arn
}
