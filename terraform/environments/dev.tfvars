# SPDX-License-Identifier: MIT
# environments/dev.tfvars — desarrollo, coste $0 (FinOps por defecto)
# Uso: terraform plan -var-file=environments/dev.tfvars
#      terraform apply -var-file=environments/dev.tfvars
# Backend: terraform init -backend-config=environments/backend-dev.hcl

project_name = "erp-pipeline"
environment  = "dev"
aws_region   = "us-east-2"

db_name     = "erpdb"
db_username = "erpadmin"
app_port    = 3000

github_repo = "Francisco-cor/Pipeline_CI-CD_IaC"
alert_email = ""

# Fase 7 toggles — dev mantiene FinOps $0
enable_nat_gateway         = false
enable_deletion_protection = false
enable_service_discovery   = false

# ECR mantiene al menos 5 imágenes para rollback (Fase 7.5)
ecr_image_retention_count = 5

# Fase 10 toggles — dev FinOps $0 (todos false). Toggle true solo en prod con enable_nat_gateway=true
enable_alb               = false
acm_certificate_arn      = ""
enable_autoscaling       = false
autoscaling_min_capacity = 1
autoscaling_max_capacity = 4
enable_redis             = false
enable_sqs               = false
