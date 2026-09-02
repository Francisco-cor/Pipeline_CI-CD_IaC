# -----------------------------------------------------------------------------
# modules/compute/outputs.tf
# -----------------------------------------------------------------------------

output "ecs_cluster_name" {
  description = "Name of the ECS cluster. Used by CI/CD to trigger rolling deployments: aws ecs update-service --cluster <name>"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.main.arn
}

output "ecs_service_name" {
  description = "ECS service name. Used by deploy.sh: aws ecs update-service --service <name>"
  value       = aws_ecs_service.app.name
}

output "task_definition_arn" {
  description = "ARN of the Terraform-managed task definition revision (used as the base for CI/CD deployments)."
  value       = aws_ecs_task_definition.app.arn
}

output "log_group_name" {
  description = "Name of the CloudWatch log group for ECS container logs. View logs with: aws logs tail <name> --follow"
  value       = aws_cloudwatch_log_group.ecs.name
}

output "ecr_repositories" {
  description = "Map of service name → ECR repository URL. Used by deploy.sh to push images."
  value       = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}

output "alb_dns_name" {
  description = "Fase 10.4 — ALB DNS when enable_alb=true, empty otherwise."
  value       = var.enable_alb ? try(aws_lb.main[0].dns_name, "") : ""
}

output "alb_target_group_arn" {
  value = var.enable_alb ? try(aws_lb_target_group.app[0].arn, "") : ""
}

output "autoscaling_enabled" {
  value = var.enable_autoscaling
}
