# -----------------------------------------------------------------------------
# dashboard.tf — CloudWatch dashboard (Fase 9.4)
# 4-6 widgets: ECS CPU/Mem, ServiceErrorCount, HttpLatency p95, 5xx, DB connections
# Namespace: erp-pipeline/dev|prod (via EMF + metric filters en observability.tf)
# Coste: $3/mes por dashboard (3 widgets gratis) — en dev se puede deshabilitar via var
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-${var.environment}-overview"

  dashboard_body = jsonencode({
    widgets = [
      # Widget 1: ECS CPU & Memory (AWS/ECS)
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ECS — CPU / Memory (Cluster ${var.project_name}-${var.environment})"
          region = var.aws_region
          period = 300
          stat   = "Average"
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", "${var.project_name}-${var.environment}-cluster", { label = "CPU %" }],
            [".", "MemoryUtilization", ".", ".", { label = "Memory %" }],
          ]
          view    = "timeSeries"
          stacked = false
        }
      },
      # Widget 2: ServiceErrorCount (logs → metric filter)
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Service Errors — ServiceErrorCount (5m)"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["${var.project_name}/${var.environment}", "ServiceErrorCount", { label = "errors/5m", color = "#d13239" }],
          ]
          annotations = {
            horizontal = [{ label = "threshold 10", value = 10, color = "#ff7f0e" }]
          }
          view = "timeSeries"
        }
      },
      # Widget 3: HttpLatency p95 (EMF) + 5xx count
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "HTTP Latency p95 + 5xx (EMF: HttpLatency / Http5xxCount)"
          region = var.aws_region
          period = 300
          metrics = [
            ["${var.project_name}/${var.environment}", "HttpLatency", { label = "p95 ms", stat = "p95", color = "#1f77b4" }],
            ["${var.project_name}/${var.environment}", "Http5xxCount", { label = "5xx/5m", stat = "Sum", color = "#ff7f0e" }],
          ]
          annotations = {
            horizontal = [{ label = "p95 500ms", value = 500, color = "#d62728" }]
          }
          view = "timeSeries"
        }
      },
      # Widget 4: RDS DB Connections + CPU
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "RDS — DBConnections + CPU (t3.micro)"
          region = var.aws_region
          period = 300
          metrics = [
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "${var.project_name}-${var.environment}-postgres", { label = "DB conns", stat = "Maximum" }],
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "${var.project_name}-${var.environment}-postgres", { label = "RDS CPU %" }],
          ]
          view = "timeSeries"
        }
      },
      # Widget 5: Log Insights — top errors (text)
      {
        type   = "log"
        x      = 0
        y      = 12
        width  = 24
        height = 6
        properties = {
          title  = "Logs — Top 5 errors (last 1h)"
          region = var.aws_region
          query  = "SOURCE '/ecs/${var.project_name}-${var.environment}' | filter level=\"error\" | stats count() as c by service, message | sort c desc | limit 5"
          view   = "table"
        }
      },
      # Widget 6: Latency histogram (p50/p95/p99)
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 24
        height = 6
        properties = {
          title  = "Latency percentiles (EMF HttpLatency)"
          region = var.aws_region
          period = 300
          metrics = [
            ["${var.project_name}/${var.environment}", "HttpLatency", { label = "p50", stat = "p50" }],
            ["${var.project_name}/${var.environment}", "HttpLatency", { label = "p95", stat = "p95" }],
            ["${var.project_name}/${var.environment}", "HttpLatency", { label = "p99", stat = "p99" }],
          ]
          view = "timeSeries"
        }
      },
    ]
  })
}

output "dashboard_name" {
  description = "CloudWatch dashboard name"
  value       = aws_cloudwatch_dashboard.main.dashboard_name
}
