# -----------------------------------------------------------------------------
# observability.tf — CloudWatch log-based alerting
#
# All backend services log in structured JSON to stdout (src/logger.js).
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

  depends_on = [module.compute]

  metric_transformation {
    name          = "ServiceErrorCount"
    namespace     = "${var.project_name}/${var.environment}"
    value         = "1"
    default_value = "0" # report 0 when there are no matching log events
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

# -----------------------------------------------------------------------------
# Fase 9.3 + 9.5 — HTTP latency & 5xx metric filters (EMF + JSON logs)
# http_request logs tienen { message="http_request", ms, status, requestId, service }
# EMF también publica HttpLatency/HttpRequestCount con _aws
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "http_latency" {
  name           = "${var.project_name}-${var.environment}-http-latency"
  pattern        = "{ $.message = \"http_request\" }"
  log_group_name = "/ecs/${var.project_name}-${var.environment}"

  depends_on = [module.compute]

  metric_transformation {
    name          = "HttpLatency"
    namespace     = "${var.project_name}/${var.environment}"
    value         = "$.ms"
    unit          = "Milliseconds"
    default_value = 0
  }
}

resource "aws_cloudwatch_log_metric_filter" "http_5xx" {
  name           = "${var.project_name}-${var.environment}-http-5xx"
  pattern        = "{ $.status >= 500 }"
  log_group_name = "/ecs/${var.project_name}-${var.environment}"

  depends_on = [module.compute]

  metric_transformation {
    name          = "Http5xxCount"
    namespace     = "${var.project_name}/${var.environment}"
    value         = "1"
    default_value = 0
  }
}

# Alarm: p95 latency >500ms (Fase 9.5)
resource "aws_cloudwatch_metric_alarm" "high_latency_p95" {
  alarm_name          = "${var.project_name}-${var.environment}-high-latency-p95"
  alarm_description   = "p95 latency >500ms for 5m — investigate slow queries or DB (pg_stat_statements log_min_duration 1000)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HttpLatency"
  namespace           = "${var.project_name}/${var.environment}"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 500
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# Alarm: 5xx rate >10 in 5m (Fase 9.5)
resource "aws_cloudwatch_metric_alarm" "high_5xx_rate" {
  alarm_name          = "${var.project_name}-${var.environment}-high-5xx-rate"
  alarm_description   = "More than 10 HTTP 5xx in 5 minutes — possible bug or DB down."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Http5xxCount"
  namespace           = "${var.project_name}/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# Alarm: RDS DB connections >80 (Fase 9.5) — t3.micro max ~112, 80 es 70% para anticipar pool exhaustion
resource "aws_cloudwatch_metric_alarm" "db_connections_high" {
  alarm_name          = "${var.project_name}-${var.environment}-db-connections-high"
  alarm_description   = "RDS DatabaseConnections >80 — pool exhaustion (DB_POOL_MAX=3 per service, check for leaks)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  dimensions = {
    DBInstanceIdentifier = "${var.project_name}-${var.environment}-postgres"
  }
  period             = 300
  statistic          = "Maximum"
  threshold          = 80
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ----------------------------------------------------------------------------
# SQS / outbox alerting (only when the queue is enabled)
#
# CloudWatch exposes queue depth and message age without requiring an
# application-side exporter. These alarms cover the operational failure modes
# of the transactional outbox: relay backlog, slow delivery, and messages
# moved to the DLQ after repeated delivery failures.
# ----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "sqs_backlog_high" {
  count = var.enable_sqs ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-sqs-backlog-high"
  alarm_description   = "More than 10 messages visible in the ordenes queue for 5 minutes — investigate the outbox relay or stock consumer."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  dimensions = {
    QueueName = aws_sqs_queue.ordenes[0].name
  }
  period             = 300
  statistic          = "Maximum"
  threshold          = 10
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "sqs_oldest_message_high" {
  count = var.enable_sqs ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-sqs-oldest-message-high"
  alarm_description   = "The oldest ordenes message is over 5 minutes old — investigate relay latency, consumer health, and database locks."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  dimensions = {
    QueueName = aws_sqs_queue.ordenes[0].name
  }
  period             = 300
  statistic          = "Maximum"
  threshold          = 300
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "sqs_dlq_not_empty" {
  count = var.enable_sqs ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-sqs-dlq-not-empty"
  alarm_description   = "At least one message is in the ordenes DLQ — inspect the event payload and consumer failure before replaying it."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  dimensions = {
    QueueName = aws_sqs_queue.ordenes_dlq[0].name
  }
  period             = 60
  statistic          = "Maximum"
  threshold          = 1
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

output "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarm notifications."
  value       = aws_sns_topic.alerts.arn
}

output "alarm_names" {
  description = "List of CloudWatch alarms created for this environment."
  value = concat(
    [
      aws_cloudwatch_metric_alarm.high_error_rate.alarm_name,
      aws_cloudwatch_metric_alarm.high_latency_p95.alarm_name,
      aws_cloudwatch_metric_alarm.high_5xx_rate.alarm_name,
      aws_cloudwatch_metric_alarm.db_connections_high.alarm_name,
    ],
    var.enable_sqs ? [
      aws_cloudwatch_metric_alarm.sqs_backlog_high[0].alarm_name,
      aws_cloudwatch_metric_alarm.sqs_oldest_message_high[0].alarm_name,
      aws_cloudwatch_metric_alarm.sqs_dlq_not_empty[0].alarm_name,
    ] : []
  )
}
