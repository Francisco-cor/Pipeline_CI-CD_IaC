# SPDX-License-Identifier: MIT
# environments/staging.tfvars — pre-prod, espejo de prod pero sin protecciones duras
# Uso: terraform plan -var-file=environments/staging.tfvars

project_name = "erp-pipeline"
environment  = "staging"
aws_region   = "us-east-2"

db_name     = "erpdb"
db_username = "erpadmin"
app_port    = 3000

github_repo = "Francisco-cor/Pipeline_CI-CD_IaC"
alert_email = ""

# Staging: protege menos que prod pero más que dev
enable_nat_gateway         = false
enable_deletion_protection = false
enable_service_discovery   = true

ecr_image_retention_count = 5

# Fase 10 toggles — staging replica prod toggles sin coste (ALB/autoscaling false por defecto)
enable_alb               = false
acm_certificate_arn      = ""
enable_autoscaling       = false
autoscaling_min_capacity = 1
autoscaling_max_capacity = 4
enable_redis             = false
enable_sqs               = false
