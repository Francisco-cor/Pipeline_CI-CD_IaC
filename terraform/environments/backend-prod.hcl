# SPDX-License-Identifier: MIT
# backend-prod.hcl — S3 remote state para prod (Fase 7.1)
# Creado por: ./scripts/bootstrap-backend.sh erp-pipeline prod us-east-2
# Uso: terraform init -backend-config=environments/backend-prod.hcl

bucket         = "erp-pipeline-tfstate-prod"
key            = "terraform.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
