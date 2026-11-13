# SPDX-License-Identifier: MIT
# backend-bootstrap-prod.hcl — S3 remote state para el stack de bootstrap (prod)
# Usa el mismo bucket/tabla que la app, con una key propia para no pisar
# terraform.tfstate.
# Uso: cd terraform/bootstrap
#      terraform init -backend-config=../environments/backend-bootstrap-prod.hcl

bucket         = "erp-pipeline-tfstate-prod"
key            = "bootstrap.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
