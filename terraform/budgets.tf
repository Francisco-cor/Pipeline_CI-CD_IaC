# -----------------------------------------------------------------------------
# budgets.tf — FinOps guardrail per environment
#
# One monthly COST budget per environment state. The budget is filtered by the
# Environment cost-allocation tag so dev/staging/prod budgets do not all track
# the same account-wide total. Cost allocation tags must be activated once in
# the Billing console (or with `aws ce update-cost-allocation-tags-status`) or
# the filter matches nothing; see docs/observability.md#finops--budgets-y-tags.
#
# Notifications go to the same SNS topic as the CloudWatch alarms at 50%, 80%
# and 100% of actual spend. That topic already fans out to alert_email and the
# optional alert_webhook_url, so there is no second notification channel to
# keep in sync. AWS Budgets accepts SNS subscribers directly; no email
# fallback is needed.
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# Budgets publishes to SNS as a service principal. The topic policy must grant
# budgets.amazonaws.com sns:Publish, scoped to this account. The owner
# statement is kept so CloudWatch alarms and operators retain access after
# Terraform replaces the default topic policy.
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid    = "AllowOwnerAccount"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }

    actions = [
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:AddPermission",
      "sns:RemovePermission",
      "sns:DeleteTopic",
      "sns:Subscribe",
      "sns:ListSubscriptionsByTopic",
      "sns:Publish",
    ]

    resources = [aws_sns_topic.alerts.arn]
  }

  statement {
    sid    = "AllowBudgetsPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project_name}-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Environment$%s", var.environment)]
  }

  dynamic "notification" {
    for_each = [50, 80, 100]

    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-monthly"
  }
}

output "monthly_budget_name" {
  description = "Name of the monthly AWS Budget for this environment."
  value       = aws_budgets_budget.monthly.name
}

output "monthly_budget_usd" {
  description = "Monthly budget limit in USD for this environment."
  value       = var.monthly_budget_usd
}
