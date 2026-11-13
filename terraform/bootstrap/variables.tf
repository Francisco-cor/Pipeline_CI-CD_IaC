# SPDX-License-Identifier: MIT
# variables.tf — bootstrap stack inputs.
#
# Defaults match the dev environment documented in the README. Apply this
# stack once per AWS account; the GitHub repository can only have a single
# AWS_ROLE_ARN secret, so one role serves every environment that shares the
# account.

variable "project_name" {
  description = "Project prefix used for the IAM role name."
  type        = string
  default     = "erp-pipeline"
}

variable "environment" {
  description = "Environment suffix for the IAM role name (dev/staging/prod)."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region for the provider and policy ARNs."
  type        = string
  default     = "us-east-2"
}

variable "github_repo" {
  description = "GitHub repository allowed to assume the role, as owner/repo."
  type        = string
  default     = "Francisco-cor/Pipeline_CI-CD_IaC"
}
