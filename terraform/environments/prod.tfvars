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
enable_nat_gateway         = false # toggle true cuando se migre a private subnets + ALB (Fase 10)
enable_deletion_protection = true
enable_service_discovery   = true

ecr_image_retention_count = 5
