# -----------------------------------------------------------------------------
# observability.tf — CloudWatch log-based alerting
#
# All three services log in structured JSON to stdout (src/logger.js).
# CloudWatch Logs captures this output automatically in Fargate.
# A metric filter counts lines where $.level = "error", and an alarm fires
# when the error count exceeds the threshold in a 5-minute window.
#
# Why absolute count (10) instead of error rate (5%)?
# Calculating a percentage requires both an error count AND a total request
# count metric. The request count would need a second metric filter on every
# log line. For a portfolio-scale service, "10 errors in 5 minutes" is an
# equally effective signal with half the complexity. See ADR-002.
# -----------------------------------------------------------------------------

# SNS topic — single fan-out point for all alarms in this environment
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-${var.environment}-alerts"
}

# Email subscription: set alert_email in terraform.tfvars to receive alerts.
# Terraform creates the subscription; AWS sends a confirmation email that must
# be clicked before notifications are delivered.
resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Metric filter: increment ServiceErrorCount by 1 for each JSON log line
# where the level field equals "error".
# Pattern uses CloudWatch Logs JSON filter syntax (not a regex).
resource "aws_cloudwatch_log_metric_filter" "service_errors" {
  name           = "${var.project_name}-${var.environment}-service-errors"
  pattern        = "{ $.level = \"error\" }"
  log_group_name = "/ecs/${var.project_name}-${var.environment}"

  metric_transformation {
    name          = "ServiceErrorCount"
    namespace     = "${var.project_name}/${var.environment}"
    value         = "1"
    default_value = "0"  # report 0 when there are no matching log events
  }
}

# Alarm: fire when ServiceErrorCount > 10 in any 5-minute window
resource "aws_cloudwatch_metric_alarm" "high_error_rate" {
  alarm_name          = "${var.project_name}-${var.environment}-high-error-rate"
  alarm_description   = "More than 10 service errors in 5 minutes — investigate or trigger rollback."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ServiceErrorCount"
  namespace           = "${var.project_name}/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

output "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarm notifications."
  value       = aws_sns_topic.alerts.arn
}
