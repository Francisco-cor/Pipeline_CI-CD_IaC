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

# HTTPS subscription for a paging/chat relay (PagerDuty, Opsgenie, or an
# SNS-to-Slack bridge). SNS sends a SubscriptionConfirmation POST to the
# endpoint; endpoint_auto_confirms lets relays that implement the handshake
# confirm without a human. A plain Slack incoming webhook does NOT implement
# the SNS handshake, so use a relay in that case. If the endpoint cannot
# auto-confirm, the subscription stays pending and Terraform cannot delete it.
resource "aws_sns_topic_subscription" "webhook" {
  count     = var.alert_webhook_url != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "https"
  endpoint  = var.alert_webhook_url

  endpoint_auto_confirms          = true
  confirmation_timeout_in_minutes = 5
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

# -----------------------------------------------------------------------------
# ECS service health — RunningTaskCount < DesiredCount
#
# Metric math compares the two gauges the ECS service publishes. A sustained
# shortfall means tasks cannot start (image pull, secret, subnet, capacity) or
# are crash-looping, which no application-level metric can see when the
# container dies before logging.
#
# Period 60s, 2 datapoints (2 minutes): fast enough to page before the ALB has
# no healthy target, slow enough to ignore the normal replacement gap during a
# rolling deployment. Missing data is BREACHING because this alarm exists to
# detect a service that stopped reporting: silence here is the failure mode.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks_low" {
  alarm_name          = "${var.project_name}-${var.environment}-ecs-running-tasks-low"
  alarm_description   = "ECS RunningTaskCount < DesiredCount for 2 minutes — tasks cannot start or are crash-looping. See docs/runbooks/alert.md#4-ecs."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  treat_missing_data  = "breaching"

  metric_query {
    id          = "running"
    label       = "RunningTaskCount"
    return_data = false

    metric {
      namespace   = "AWS/ECS"
      metric_name = "RunningTaskCount"
      period      = 60
      stat        = "Average"
      dimensions = {
        ClusterName = module.compute.ecs_cluster_name
        ServiceName = module.compute.ecs_service_name
      }
    }
  }

  metric_query {
    id          = "desired"
    label       = "DesiredCount"
    return_data = false

    metric {
      namespace   = "AWS/ECS"
      metric_name = "DesiredCount"
      period      = 60
      stat        = "Average"
      dimensions = {
        ClusterName = module.compute.ecs_cluster_name
        ServiceName = module.compute.ecs_service_name
      }
    }
  }

  metric_query {
    id          = "shortfall"
    label       = "1 when running < desired"
    expression  = "IF(running < desired, 1, 0)"
    return_data = true
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# ALB alarms (only when the load balancer exists)
#
# UnHealthyHostCount: any unhealthy target for 2 minutes is a page. Missing
# data is BREACHING: if the ALB stops publishing, the service is unreachable.
#
# TargetResponseTime p95 > 0.5s over 10 minutes: page for the latency SLO.
# Missing data is NOT breaching — an idle ALB legitimately has no samples.
#
# 5xx ratio > 1%: metric math turns two counters into the error-budget signal
# the SLO is written against. A ratio avoids paging at 03:00 for two 5xx on a
# handful of requests. Missing data (no traffic) is NOT breaching.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  count = var.enable_alb ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-unhealthy-hosts"
  alarm_description   = "At least one ALB target is unhealthy for 2 minutes — check ECS task health and /health. See docs/runbooks/alert.md#5-alb."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "breaching"

  dimensions = {
    LoadBalancer = module.compute.alb_arn_suffix
    TargetGroup  = module.compute.alb_target_group_arn_suffix
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_latency_p95" {
  count = var.enable_alb ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-latency-p95"
  alarm_description   = "ALB p95 target response time >500ms for 10 minutes — latency SLO burn. See docs/observability.md#slis-slos-y-error-budget."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 0.5
  unit                = "Seconds"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = module.compute.alb_arn_suffix
    TargetGroup  = module.compute.alb_target_group_arn_suffix
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx_ratio" {
  count = var.enable_alb ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-5xx-ratio"
  alarm_description   = "ALB target 5xx ratio >1% for 10 minutes — error SLO burn. See docs/runbooks/alert.md#5-alb."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "errors"
    label       = "Target 5xx"
    return_data = false

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = module.compute.alb_arn_suffix
        TargetGroup  = module.compute.alb_target_group_arn_suffix
      }
    }
  }

  metric_query {
    id          = "requests"
    label       = "RequestCount"
    return_data = false

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = module.compute.alb_arn_suffix
        TargetGroup  = module.compute.alb_target_group_arn_suffix
      }
    }
  }

  metric_query {
    id          = "ratio"
    label       = "5xx % of requests"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    return_data = true
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# RDS capacity alarms
#
# FreeStorageSpace < 10 GiB: 2 consecutive 5-minute samples. Missing data is
# BREACHING because a stopped/unreachable instance stops publishing and that is
# itself an outage. 10 GiB leaves room for vacuum, WAL and a snapshot copy.
#
# CPUUtilization > 80% for 15 minutes: NOT breaching on gaps (maintenance
# windows and reboots are normal). 15 minutes filters migration spikes and
# points at a sustained query or connection problem.
#
# DatabaseConnections already has an alarm (db_connections_high); it is not
# duplicated here.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "rds_free_storage_low" {
  alarm_name          = "${var.project_name}-${var.environment}-rds-free-storage-low"
  alarm_description   = "RDS free storage below 10 GiB — autovacuum/WAL growth or a runaway table. See docs/runbooks/alert.md#6-rds."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = 10737418240 # 10 GiB in bytes
  unit                = "Bytes"
  treat_missing_data  = "breaching"

  dimensions = {
    DBInstanceIdentifier = module.database.rds_identifier
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.project_name}-${var.environment}-rds-cpu-high"
  alarm_description   = "RDS CPU above 80% for 15 minutes — slow query or connection storm. See docs/runbooks/alert.md#6-rds."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = module.database.rds_identifier
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# WAF blocked requests (only when the web ACL exists)
#
# A block spike means either an attack (expected, no action beyond confirming
# the ALB is healthy) or a false positive breaking real traffic. 1000 blocked
# requests in 5 minutes is twice the per-IP rate limit and well above organic
# scanner noise. Missing data is NOT breaching: no traffic produces no WAF
# samples, which is normal for a low-volume environment.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests_high" {
  count = var.enable_waf ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-waf-blocked-requests-high"
  alarm_description   = "WAF blocked more than 1000 requests in 5 minutes — attack or false positive. Check sampled requests before changing rules. See docs/runbooks/alert.md#8-waf."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 1000
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = module.waf[0].web_acl_name
    Rule   = "ALL"
    Region = var.aws_region
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
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
      aws_cloudwatch_metric_alarm.ecs_running_tasks_low.alarm_name,
      aws_cloudwatch_metric_alarm.rds_free_storage_low.alarm_name,
      aws_cloudwatch_metric_alarm.rds_cpu_high.alarm_name,
    ],
    var.enable_alb ? [
      aws_cloudwatch_metric_alarm.alb_unhealthy_hosts[0].alarm_name,
      aws_cloudwatch_metric_alarm.alb_latency_p95[0].alarm_name,
      aws_cloudwatch_metric_alarm.alb_5xx_ratio[0].alarm_name,
    ] : [],
    var.enable_waf ? [
      aws_cloudwatch_metric_alarm.waf_blocked_requests_high[0].alarm_name,
    ] : [],
    var.enable_sqs ? [
      aws_cloudwatch_metric_alarm.sqs_backlog_high[0].alarm_name,
      aws_cloudwatch_metric_alarm.sqs_oldest_message_high[0].alarm_name,
      aws_cloudwatch_metric_alarm.sqs_dlq_not_empty[0].alarm_name,
    ] : []
  )
}
