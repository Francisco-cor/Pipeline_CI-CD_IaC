# sqs.tf — Fase 10.6 SQS queue para ordenes → stock async
# Toggle var.enable_sqs (default false FinOps). Cuando true crea queue + DLQ.

resource "aws_sqs_queue" "ordenes_dlq" {
  count = var.enable_sqs ? 1 : 0
  name  = "${var.project_name}-${var.environment}-ordenes-dlq"

  message_retention_seconds = 1209600 # 14 days

  tags = {
    Name = "${var.project_name}-${var.environment}-ordenes-dlq"
  }
}

resource "aws_sqs_queue" "ordenes" {
  count = var.enable_sqs ? 1 : 0
  name  = "${var.project_name}-${var.environment}-ordenes"

  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ordenes_dlq[0].arn
    maxReceiveCount     = 5
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-ordenes"
  }
}

# Policy para que tasks puedan Send/Receive/Delete (Fase 10.6 — opcional prod)
# Se adjunta via tasK_role (ver modules/secrets). Aquí dejamos arn para data.

resource "aws_sqs_queue_policy" "ordenes" {
  count     = var.enable_sqs ? 1 : 0
  queue_url = aws_sqs_queue.ordenes[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = "*"
        Action    = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource  = aws_sqs_queue.ordenes[0].arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:*:service/${var.project_name}-${var.environment}-service"
          }
        }
      }
    ]
  })
}
