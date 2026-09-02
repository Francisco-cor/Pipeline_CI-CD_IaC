# SPDX-License-Identifier: MIT
# backend-dev.hcl — S3 remote state para dev (Fase 7.1)
# Creado por: ./scripts/bootstrap-backend.sh erp-pipeline dev us-east-2
# Uso: terraform init -backend-config=environments/backend-dev.hcl
#      terraform init -reconfigure -backend-config=environments/backend-dev.hcl

bucket         = "erp-pipeline-tfstate-dev"
key            = "terraform.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
