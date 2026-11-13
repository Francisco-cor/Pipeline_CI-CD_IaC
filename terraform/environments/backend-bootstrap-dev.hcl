# SPDX-License-Identifier: MIT
# backend-bootstrap-dev.hcl — S3 remote state para el stack de bootstrap (dev)
# Usa el mismo bucket/tabla que la app, con una key propia para no pisar
# terraform.tfstate.
# Uso: cd terraform/bootstrap
#      terraform init -backend-config=../environments/backend-bootstrap-dev.hcl

bucket         = "erp-pipeline-tfstate-dev"
key            = "bootstrap.tfstate"
region         = "us-east-2"
dynamodb_table = "erp-pipeline-tfstate-lock"
encrypt        = true
