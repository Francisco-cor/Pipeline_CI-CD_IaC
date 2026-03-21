# -----------------------------------------------------------------------------
# modules/secrets/main.tf
#
# Creates:
#   1. Secrets Manager secrets for DB URL, Redis URL, and app JWT secret
#   2. Secret versions with actual values (DB and Redis — built from RDS/Redis outputs)
#   3. ECS Task Execution IAM Role (pulls images, reads secrets, writes logs)
#   4. ECS Task IAM Role (the app itself — no permissions by default)
#
# IAM principle of least privilege:
#   The task execution role's inline policy grants secretsmanager:GetSecretValue
#   ONLY on the specific 3 secret ARNs created here — NOT on "*". This means a
#   compromise of the ECS task execution role cannot read other secrets in the
#   account.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Secret: /erp/db-url
#
# Stores the full PostgreSQL connection string in the format expected by most
# Node.js ORMs (Prisma, TypeORM, Sequelize, pg):
#   postgresql://username:password@host:port/dbname
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "db_url" {
  name        = "/${var.project_name}/${var.environment}/db-url"
  description = "Full PostgreSQL DATABASE_URL connection string for the ${var.project_name} ${var.environment} environment. Injected into ECS containers as the DATABASE_URL environment variable."

  # Allow immediate deletion without a recovery window in dev (saves cost and
  # avoids name-collision issues when re-deploying). In prod, set this to 7-30.
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-db-url"
  }
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id = aws_secretsmanager_secret.db_url.id

  # Build a standard PostgreSQL connection string from RDS outputs.
  # The password comes from the database module's random_password resource.
  # Terraform marks this as sensitive in state due to var.rds_password.
  secret_string = "postgresql://${var.rds_username}:${var.rds_password}@${var.rds_endpoint}:${var.rds_port}/${var.rds_db_name}"
}

# -----------------------------------------------------------------------------
# Secret: /erp/redis-url
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "redis_url" {
  name        = "/${var.project_name}/${var.environment}/redis-url"
  description = "Redis connection string for the ${var.project_name} ${var.environment} environment. Injected as REDIS_URL."

  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-redis-url"
  }
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "redis://${var.redis_endpoint}:${var.redis_port}"
}

# -----------------------------------------------------------------------------
# Secret: /erp/app-secret
#
# Placeholder for the application's JWT signing secret.
# The initial value ("REPLACE_ME_BEFORE_DEPLOY") is intentionally invalid to
# prevent accidental production use. Inject the real value:
#   aws secretsmanager put-secret-value \
#     --secret-id /${project_name}/${environment}/app-secret \
#     --secret-string "$(openssl rand -base64 64)"
# Or inject via CI/CD pipeline using a repository secret.
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "app_secret" {
  name        = "/${var.project_name}/${var.environment}/app-secret"
  description = "JWT signing secret for the ${var.project_name} ${var.environment} application. Initial value is a placeholder — replace before deploying the application."

  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-app-secret"
  }
}

resource "aws_secretsmanager_secret_version" "app_secret" {
  secret_id     = aws_secretsmanager_secret.app_secret.id
  secret_string = "REPLACE_ME_BEFORE_DEPLOY" # Replace via CI/CD or manually
}

# -----------------------------------------------------------------------------
# IAM Role: ECS Task Execution Role
#
# ECS (the control plane) assumes this role to:
#   1. Pull the container image from ECR
#   2. Create CloudWatch log streams and push log events
#   3. Fetch secrets from Secrets Manager at container startup
#
# It does NOT run inside the container — that is the task role below.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_task_execution_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.project_name}-${var.environment}-ecs-task-execution-role"
  description        = "Allows ECS to pull images from ECR, write logs to CloudWatch, and fetch secrets from Secrets Manager for ${var.project_name} ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_trust.json

  tags = {
    Name = "${var.project_name}-${var.environment}-ecs-task-execution-role"
  }
}

# AWS managed policy: covers ECR pull and CloudWatch Logs write permissions
resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Inline policy: restrict Secrets Manager access to ONLY the 3 secrets above.
# Using an inline policy (vs. a managed policy) keeps the permission scoped
# to exactly this set of secrets and makes the boundary explicit in code.
data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid    = "AllowGetSpecificSecrets"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
    ]

    # Explicitly enumerate the 3 secrets — NOT "arn:aws:secretsmanager:*:*:secret:*"
    # This ensures the execution role cannot read any other secrets in the account.
    resources = [
      aws_secretsmanager_secret.db_url.arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.app_secret.arn,
    ]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "allow-get-specific-secrets"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

# -----------------------------------------------------------------------------
# IAM Role: ECS Task Role
#
# The running application container assumes this role. It is the identity used
# for any AWS SDK calls made from inside the app (e.g., S3, SES, SQS in the
# future). Starting with zero permissions enforces the principle of least
# privilege — add only what the app actually needs in future weeks.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_task_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task" {
  name               = "${var.project_name}-${var.environment}-ecs-task-role"
  description        = "Runtime identity for ${var.project_name} ${var.environment} application containers. No permissions by default — extend as needed."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json

  tags = {
    Name = "${var.project_name}-${var.environment}-ecs-task-role"
  }
}
