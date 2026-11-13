# SPDX-License-Identifier: MIT
# versions.tf — providers and remote state for the bootstrap stack.
#
# State lives next to the app state (same bucket/table, distinct key) so the
# identity survives `terraform destroy` runs in ../:
#   terraform init -backend-config=../environments/backend-dev.hcl \
#     -backend-config="key=bootstrap.tfstate"

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      # Used by cicd.tf to fetch GitHub's OIDC certificate thumbprint
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      Stack       = "bootstrap"
    }
  }
}
