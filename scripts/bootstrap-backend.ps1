# =============================================================================
# bootstrap-backend.ps1 — Create Terraform remote state infrastructure
#
# Run this script ONCE before running `terraform init`. It creates:
#   1. An S3 bucket for Terraform state storage (versioned + encrypted)
#   2. A DynamoDB table for Terraform state locking
#
# Usage:
#   .\scripts\bootstrap-backend.ps1 -ProjectName "erp-pipeline" -Environment "dev" -Region "us-east-2"
# =============================================================================

param (
    [string]$ProjectName = "erp-pipeline",
    [string]$Environment = "dev",
    [string]$Region = "us-east-2"
)

$Bucket = "${ProjectName}-tfstate-${Environment}"
$Table = "${ProjectName}-tfstate-lock"

Write-Host "==========================================" -ForegroundColor Green
Write-Host " Terraform Backend Bootstrap (PowerShell)"
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Project:   $ProjectName"
Write-Host " Env:       $Environment"
Write-Host " Region:    $Region"
Write-Host " S3 Bucket: $Bucket"
Write-Host " DynamoDB:  $Table"
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# 1. Create S3 bucket
Write-Host "[1/6] Creating S3 bucket: $Bucket"
$bucketExists = (aws s3api head-bucket --bucket "$Bucket" 2>&1)
if ($bucketExists.ToString() -match "404") {
    aws s3api create-bucket `
      --bucket "$Bucket" `
      --region "$Region" `
      --create-bucket-configuration LocationConstraint="$Region"
    Write-Host "      Created."
} else {
    Write-Host "      Already exists."
}

# 2. Enable versioning
Write-Host "[2/6] Enabling versioning on S3 bucket"
aws s3api put-bucket-versioning `
  --bucket "$Bucket" `
  --versioning-configuration Status=Enabled
Write-Host "      OK"

# 3. Enable encryption
Write-Host "[3/6] Enabling AES-256 encryption on S3 bucket"
$encryptionConfig = '{\"Rules\": [{\"ApplyServerSideEncryptionByDefault\": {\"SSEAlgorithm\": \"AES256\"}, \"BucketKeyEnabled\": true}]}'
aws s3api put-bucket-encryption `
  --bucket "$Bucket" `
  --server-side-encryption-configuration "$encryptionConfig"
Write-Host "      OK"

# 4. Block public access
Write-Host "[4/6] Blocking all public access on S3 bucket"
aws s3api put-public-access-block `
  --bucket "$Bucket" `
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
Write-Host "      OK"

# 5. Enable lifecycle rule
Write-Host "[5/6] Enabling 7-day lifecycle rule for old state versions"
$lifecycleConfig = '{\"Rules\": [{\"ID\": \"CleanupOldVersions\", \"Status\": \"Enabled\", \"NoncurrentVersionExpiration\": {\"NoncurrentDays\": 7}, \"Filter\": {\"Prefix\": \"\"}}]}'
aws s3api put-bucket-lifecycle-configuration `
  --bucket "$Bucket" `
  --lifecycle-configuration "$lifecycleConfig"
Write-Host "      OK"

# 6. Create DynamoDB table
Write-Host "[6/6] Creating DynamoDB table for state locking: $Table"
$tableExists = (aws dynamodb describe-table --table-name "$Table" 2>&1)
if ($tableExists.ToString() -match "ResourceNotFoundException") {
    aws dynamodb create-table `
      --table-name "$Table" `
      --attribute-definitions AttributeName=LockID,AttributeType=S `
      --key-schema AttributeName=LockID,KeyType=HASH `
      --billing-mode PAY_PER_REQUEST `
      --region "$Region"
    Write-Host "      Created."
} else {
    Write-Host "      Already exists."
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Backend bootstrap complete!"
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host " Next steps:"
Write-Host ""
Write-Host "   cd terraform"
Write-Host "   terraform init ``"
Write-Host "     -backend-config=`"bucket=$Bucket`" ``"
Write-Host "     -backend-config=`"dynamodb_table=$Table`" ``"
Write-Host "     -backend-config=`"region=$Region`""
Write-Host ""
Write-Host "   terraform plan"
Write-Host "   terraform apply"
Write-Host "==========================================" -ForegroundColor Green
