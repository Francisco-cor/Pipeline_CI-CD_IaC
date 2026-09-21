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

# SQS access is granted to the ECS task role in modules/secrets. An identity
# policy is the correct control for same-account calls made with task-role
# credentials; a queue policy with Principal="*" would widen the trust surface.
