# SPDX-License-Identifier: MIT
# backend-staging.hcl — S3 remote state para staging (Fase 7.1)
# Creado por: ./scripts/bootstrap-backend.sh erp-pipeline staging us-east-2
# Uso: terraform init -backend-config=environments/backend-staging.hcl

bucket         = "erp-pipeline-tfstate-staging"
key            = "terraform.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
