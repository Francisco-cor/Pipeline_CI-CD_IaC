# -----------------------------------------------------------------------------
# backend.tf — Remote state configuration (S3 + DynamoDB locking)
#
# IMPORTANT: Terraform backend blocks do NOT support variable interpolation.
# The bucket name and DynamoDB table name must be literals here OR you must
# use a partial backend configuration with -backend-config flags.
#
# Option A (used here): Leave bucket/table as placeholders and supply them
#   at init time:
#
#   terraform init \
#     -backend-config="bucket=erp-pipeline-tfstate-dev" \
#     -backend-config="dynamodb_table=erp-pipeline-tfstate-lock" \
#     -backend-config="region=us-east-2"
#
# Option B: Replace the placeholder strings below with literals before running
#   terraform init (acceptable for a single-environment project).
#
# Run scripts/bootstrap-backend.sh ONCE before terraform init to create the
# S3 bucket and DynamoDB table.
# -----------------------------------------------------------------------------

terraform {
  backend "s3" {
    # Fase 7.1 — partial config: supply via -backend-config=environments/backend-*.hcl
    # Example:
    #   terraform init -backend-config=environments/backend-dev.hcl
    #   terraform init -reconfigure -backend-config=environments/backend-prod.hcl
    # bootstrap-backend.sh creates the S3 bucket + DynamoDB lock table per env.
    # Keep encrypt=true here so state at rest is always encrypted, even if
    # backend.hcl omits it.
    encrypt = true
  }
}
