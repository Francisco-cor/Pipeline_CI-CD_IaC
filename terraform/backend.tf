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
#     -backend-config="region=us-east-1"
#
# Option B: Replace the placeholder strings below with literals before running
#   terraform init (acceptable for a single-environment project).
#
# Run scripts/bootstrap-backend.sh ONCE before terraform init to create the
# S3 bucket and DynamoDB table.
# -----------------------------------------------------------------------------

terraform {
  backend "s3" {
    # These values are intentionally left as partial config placeholders.
    # Supply them via -backend-config flags (see comment above) or replace
    # with literals matching the output of bootstrap-backend.sh.
    bucket = "erp-pipeline-tfstate-dev" # replace with: ${project_name}-tfstate-${environment}
    key    = "terraform.tfstate"
    region = "us-east-1"

    # State locking via DynamoDB prevents concurrent runs from corrupting state
    dynamodb_table = "erp-pipeline-tfstate-lock" # replace with: ${project_name}-tfstate-lock

    # Always encrypt state at rest — state files contain sensitive data
    encrypt = true
  }
}
