# kms.tf — optional customer-managed key for application secrets and RDS PI

# A generated key is convenient for a new environment. Existing environments
# may provide customer_managed_kms_key_arn instead and skip key creation.
resource "aws_kms_key" "application" {
  count                   = var.enable_customer_managed_kms && (var.customer_managed_kms_key_arn == null || var.customer_managed_kms_key_arn == "") ? 1 : 0
  description             = "${var.project_name} ${var.environment} application data key"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${var.project_name}-${var.environment}-application-kms"
  }
}

resource "aws_kms_alias" "application" {
  count         = length(aws_kms_key.application)
  name          = "alias/${var.project_name}-${var.environment}-application"
  target_key_id = aws_kms_key.application[0].key_id
}

locals {
  customer_managed_kms_key_id               = var.customer_managed_kms_key_arn != null && var.customer_managed_kms_key_arn != "" ? var.customer_managed_kms_key_arn : try(aws_kms_key.application[0].arn, null)
  effective_performance_insights_kms_key_id = var.performance_insights_kms_key_id != null && var.performance_insights_kms_key_id != "" ? var.performance_insights_kms_key_id : local.customer_managed_kms_key_id
}
