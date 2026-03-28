# -----------------------------------------------------------------------------
# modules/secrets/outputs.tf
# -----------------------------------------------------------------------------

output "task_execution_role_arn" {
  description = "ARN of the ECS Task Execution IAM role. ECS uses this to pull images from ECR, write logs to CloudWatch, and fetch secrets from Secrets Manager at container startup."
  value       = aws_iam_role.ecs_task_execution.arn
}

output "task_role_arn" {
  description = "ARN of the ECS Task IAM role. The running application container assumes this role. Currently has no extra permissions (principle of least privilege); extend in future weeks as needed."
  value       = aws_iam_role.ecs_task.arn
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the full PostgreSQL DATABASE_URL connection string."
  value       = aws_secretsmanager_secret.db_url.arn
}


