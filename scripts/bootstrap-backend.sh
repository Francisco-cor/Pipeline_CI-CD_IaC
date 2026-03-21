#!/bin/bash
# =============================================================================
# bootstrap-backend.sh — Create Terraform remote state infrastructure
#
# Run this script ONCE before running `terraform init`. It creates:
#   1. An S3 bucket for Terraform state storage (versioned + encrypted)
#   2. A DynamoDB table for Terraform state locking
#
# WHY: Terraform's S3 backend requires the bucket and DynamoDB table to exist
# BEFORE terraform init runs (because init itself writes a lock). The bucket
# name also can't use Terraform variables in backend blocks, so we use a shell
# script driven by the same naming convention.
#
# Usage:
#   chmod +x scripts/bootstrap-backend.sh
#   ./scripts/bootstrap-backend.sh [PROJECT_NAME] [ENVIRONMENT] [REGION]
#
# Examples:
#   ./scripts/bootstrap-backend.sh                            # uses defaults
#   ./scripts/bootstrap-backend.sh erp-pipeline dev us-east-1
#   ./scripts/bootstrap-backend.sh my-project staging eu-west-1
#
# After running this script:
#   cd terraform
#   terraform init \
#     -backend-config="bucket=${PROJECT_NAME}-tfstate-${ENVIRONMENT}" \
#     -backend-config="dynamodb_table=${PROJECT_NAME}-tfstate-lock" \
#     -backend-config="region=${REGION}"
#
# Prerequisites:
#   - AWS CLI configured with credentials that have permissions to create
#     S3 buckets and DynamoDB tables
#   - Required IAM actions:
#       s3:CreateBucket, s3:PutBucketVersioning, s3:PutBucketEncryption,
#       s3:PutPublicAccessBlock, dynamodb:CreateTable
# =============================================================================

set -euo pipefail

PROJECT_NAME=${1:-"erp-pipeline"}
ENVIRONMENT=${2:-"dev"}
REGION=${3:-"us-east-1"}

BUCKET="${PROJECT_NAME}-tfstate-${ENVIRONMENT}"
TABLE="${PROJECT_NAME}-tfstate-lock"

echo "=========================================="
echo " Terraform Backend Bootstrap"
echo "=========================================="
echo " Project:   ${PROJECT_NAME}"
echo " Env:       ${ENVIRONMENT}"
echo " Region:    ${REGION}"
echo " S3 Bucket: ${BUCKET}"
echo " DynamoDB:  ${TABLE}"
echo "=========================================="
echo ""

# -----------------------------------------------------------------------------
# Create S3 bucket
#
# Note: us-east-1 does not accept a LocationConstraint in create-bucket;
# all other regions require it. This conditional handles both cases.
# -----------------------------------------------------------------------------
echo "[1/5] Creating S3 bucket: ${BUCKET}"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket \
    --bucket "${BUCKET}" \
    --region "${REGION}"
else
  aws s3api create-bucket \
    --bucket "${BUCKET}" \
    --region "${REGION}" \
    --create-bucket-configuration LocationConstraint="${REGION}"
fi
echo "      OK"

# -----------------------------------------------------------------------------
# Enable versioning — required to recover from accidental state deletion or
# corruption. Terraform docs strongly recommend this.
# -----------------------------------------------------------------------------
echo "[2/5] Enabling versioning on S3 bucket"
aws s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled
echo "      OK"

# -----------------------------------------------------------------------------
# Enable server-side encryption — Terraform state often contains sensitive
# values (RDS passwords, etc.). AES-256 (SSE-S3) is free; use SSE-KMS for
# stricter compliance requirements.
# -----------------------------------------------------------------------------
echo "[3/5] Enabling AES-256 encryption on S3 bucket"
aws s3api put-bucket-encryption \
  --bucket "${BUCKET}" \
  --server-side-encryption-configuration '{
    "Rules": [
      {
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "AES256"
        },
        "BucketKeyEnabled": true
      }
    ]
  }'
echo "      OK"

# -----------------------------------------------------------------------------
# Block all public access — state files must never be publicly readable.
# This is belt-and-suspenders on top of the bucket's lack of a public policy.
# -----------------------------------------------------------------------------
echo "[4/5] Blocking all public access on S3 bucket"
aws s3api put-public-access-block \
  --bucket "${BUCKET}" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
echo "      OK"

# -----------------------------------------------------------------------------
# Create DynamoDB table for state locking
#
# PAY_PER_REQUEST billing mode: no provisioned capacity to manage; costs
# effectively $0 for the low write volume of Terraform operations.
# The LockID attribute is the key used by the Terraform S3 backend.
# -----------------------------------------------------------------------------
echo "[5/5] Creating DynamoDB table for state locking: ${TABLE}"
aws dynamodb create-table \
  --table-name "${TABLE}" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}"
echo "      OK"

echo ""
echo "=========================================="
echo " Backend bootstrap complete!"
echo "=========================================="
echo ""
echo " S3 Bucket:      ${BUCKET}"
echo " DynamoDB Table: ${TABLE}"
echo " Region:         ${REGION}"
echo ""
echo " Next steps:"
echo ""
echo "   cd terraform"
echo "   terraform init \\"
echo "     -backend-config=\"bucket=${BUCKET}\" \\"
echo "     -backend-config=\"dynamodb_table=${TABLE}\" \\"
echo "     -backend-config=\"region=${REGION}\""
echo ""
echo "   terraform plan"
echo "   terraform apply"
echo "=========================================="
