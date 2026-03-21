# -----------------------------------------------------------------------------
# modules/compute/outputs.tf
# -----------------------------------------------------------------------------

output "ecr_repository_url" {
  description = "URL of the ECR repository. CI/CD pipeline pushes images here: docker push <url>:<git_sha>. Format: <account_id>.dkr.ecr.<region>.amazonaws.com/<project_name>-app"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster. Used by CI/CD to trigger rolling deployments: aws ecs update-service --cluster <name> --service <service> --force-new-deployment"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.main.arn
}

output "task_definition_arn" {
  description = "ARN of the current (placeholder) task definition. Week 2 CI/CD will register new revisions with the real application image."
  value       = aws_ecs_task_definition.app.arn
}

output "log_group_name" {
  description = "Name of the CloudWatch log group for ECS container logs. View logs with: aws logs tail <name> --follow"
  value       = aws_cloudwatch_log_group.ecs.name
}
