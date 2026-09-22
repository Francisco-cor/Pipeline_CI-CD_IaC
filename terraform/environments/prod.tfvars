# SPDX-License-Identifier: MIT
# environments/prod.tfvars — producción, protecciones activadas
# Uso: terraform plan -var-file=environments/prod.tfvars
# ATENCIÓN: deletion_protection=true impide terraform destroy sin -target

project_name = "erp-pipeline"
environment  = "prod"
aws_region   = "us-east-2"

db_name     = "erpdb"
db_username = "erpadmin"
app_port    = 3000

github_repo = "Francisco-cor/Pipeline_CI-CD_IaC"
alert_email = "ops@example.com"

# Prod: seguridad y alta disponibilidad (ver ADR-001)
enable_nat_gateway         = true # production boundary: ECS/RDS private + NAT per AZ
enable_deletion_protection = true
enable_service_discovery   = true

ecr_image_retention_count = 5

# Fase 10 toggles — prod preparado para scale; mantener false hasta migración ALB privada documentada en ADR-004
enable_alb               = true # required to reach private ECS tasks
acm_certificate_arn      = ""   # REQUIRED: set the approved ACM certificate ARN before apply
enable_autoscaling       = true # CPU 70% / memory 80%, min 2 for HA
autoscaling_min_capacity = 2    # prod min 2 para HA cuando autoscaling true
autoscaling_max_capacity = 4
enable_redis             = false # toggle true → ElastiCache t3.micro ~$12/mes (requiere enable_nat_gateway)
enable_sqs               = false # toggle true → SQS ordenes + DLQ $0.40/millón

# Performance Insights: keep the free 7-day tier until a customer-managed KMS
# key is provisioned; values >7 require performance_insights_kms_key_id.
performance_insights_retention_days = 7
