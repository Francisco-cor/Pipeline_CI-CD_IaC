# SPDX-License-Identifier: MIT
# backend-bootstrap-staging.hcl — S3 remote state para el stack de bootstrap (staging)
# Usa el mismo bucket/tabla que la app, con una key propia para no pisar
# terraform.tfstate.
# Uso: cd terraform/bootstrap
#      terraform init -backend-config=../environments/backend-bootstrap-staging.hcl

bucket         = "erp-pipeline-tfstate-staging"
key            = "bootstrap.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
