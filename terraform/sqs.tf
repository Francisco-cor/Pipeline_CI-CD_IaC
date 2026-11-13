# sqs.tf — Fase 10.6 SQS queue para ordenes → stock async
# Toggle var.enable_sqs (default false FinOps). Cuando true crea queue + DLQ.

resource "aws_sqs_queue" "ordenes_dlq" {
  count = var.enable_sqs ? 1 : 0
  name  = "${var.project_name}-${var.environment}-ordenes-dlq"

  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "${var.project_name}-${var.environment}-ordenes-dlq"
  }
}

resource "aws_sqs_queue" "ordenes" {
  count = var.enable_sqs ? 1 : 0
  name  = "${var.project_name}-${var.environment}-ordenes"

  # The worker uses a 60s visibility timeout and deletes only after the DB
  # transaction commits. Failed deliveries remain available for retry.
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ordenes_dlq[0].arn
    maxReceiveCount     = 5
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-ordenes"
  }
}

# Same-account callers use the task identity policy (modules/secrets), not a
# Principal="*" grant. This queue policy only denies non-TLS access, which is a
# bound on the transport surface rather than a widening of who can use it.
resource "aws_sqs_queue_policy" "ordenes" {
  count     = var.enable_sqs ? 1 : 0
  queue_url = aws_sqs_queue.ordenes[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.ordenes[0].arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

resource "aws_sqs_queue_policy" "ordenes_dlq" {
  count     = var.enable_sqs ? 1 : 0
  queue_url = aws_sqs_queue.ordenes_dlq[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.ordenes_dlq[0].arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# SQS access is granted to the ECS task role in modules/secrets. An identity
# policy is the correct control for same-account calls made with task-role
# credentials; a queue policy with Principal="*" would widen the trust surface.
