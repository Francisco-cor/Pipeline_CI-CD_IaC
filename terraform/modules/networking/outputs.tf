# -----------------------------------------------------------------------------
# modules/networking/outputs.tf
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the created VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "List of public subnet IDs (one per AZ). Used by the database module for subnet groups and by the compute module for ECS task placement."
  value       = [for subnet in aws_subnet.public : subnet.id]
}

output "sg_app_id" {
  description = "ID of the application security group. Attached to ECS tasks; allows inbound HTTP/HTTPS and all outbound traffic (needed for ECR pulls and AWS API calls)."
  value       = aws_security_group.sg_app.id
}

output "sg_db_id" {
  description = "ID of the database security group. Attached to RDS; allows inbound PostgreSQL (5432) only from sg_app."
  value       = aws_security_group.sg_db.id
}

output "private_subnet_ids" {
  description = "Fase 7.3 — IDs de private subnets (empty list cuando enable_nat_gateway=false). Futuro: ECS en private + NAT para Fase 10."
  value       = var.enable_nat_gateway ? [for s in aws_subnet.private : s.id] : []
}

output "nat_gateway_id" {
  description = "ID del NAT Gateway si enable_nat_gateway=true, null si false."
  value       = var.enable_nat_gateway ? aws_nat_gateway.main[0].id : null
}

