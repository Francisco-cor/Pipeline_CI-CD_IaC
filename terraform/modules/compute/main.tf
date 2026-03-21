# -----------------------------------------------------------------------------
# modules/compute/main.tf
#
# Week 1 skeleton — creates the compute infrastructure scaffolding.
# The actual Node.js application image does not exist yet; a placeholder
# nginx container is used so the task definition is valid.
#
# Week 2 will:
#   1. Build and push the real application image to ECR via GitHub Actions
#   2. Register a new ECS task definition revision with the real image URI
#   3. Create an ECS Service to run and maintain the desired task count
#   4. (Optional) Add an ECS Service with a load balancer or use public IP
#
# Creates:
#   1. ECR repository — stores application Docker images
#   2. ECR lifecycle policy — keeps last 10 tagged images; removes untagged
#   3. ECS cluster — with Container Insights enabled for CloudWatch metrics
#   4. CloudWatch log group — 7-day retention (cost-conscious for dev)
#   5. ECS task definition — FARGATE, 256 CPU / 512 MB, nginx placeholder
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# ECR Repository
# -----------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name = "${var.project_name}-app"

  # MUTABLE allows CI/CD to push new tags (e.g., latest, git SHA) to the same
  # repository. Use IMMUTABLE in production to prevent tag overwriting.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    # Scan on push detects OS and language-level vulnerabilities automatically.
    # Results are visible in the ECR console and can be used to gate CI/CD.
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-app"
  }
}

# Lifecycle policy — prevents unbounded storage growth
# Keeps the last 10 tagged images (preserves rollback capability) and deletes
# untagged images after 1 day (untagged = intermediate build layers, build
# cache layers pushed accidentally, etc.).
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep only the last 10 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = ["v", "sha-", "latest"]
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# ECS Cluster
# -----------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-cluster"

  setting {
    # Container Insights publishes per-task CPU, memory, network, and storage
    # metrics to CloudWatch. Costs ~$0.50/cluster/month for the metrics — worth
    # it for operational visibility even in dev.
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-cluster"
  }
}

# Capacity providers — Fargate and Fargate Spot
# FARGATE_SPOT can reduce compute costs by up to 70% for non-critical workloads
# by running tasks on spare AWS capacity. Week 2 ECS service will configure the
# capacity provider strategy (e.g., 80% Spot, 20% Fargate for resilience).
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1       # Always keep at least 1 task on regular FARGATE
    weight            = 1
    capacity_provider = "FARGATE"
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
#
# 7-day retention: balances cost vs. debuggability.
# For prod, increase to 30-90 days or export to S3 for long-term storage.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}"
  retention_in_days = 7

  tags = {
    Name = "/ecs/${var.project_name}-${var.environment}"
  }
}

# -----------------------------------------------------------------------------
# ECS Task Definition (Week 1 placeholder)
#
# Uses nginx:alpine as a placeholder container. This allows the task definition
# to be valid and deployable without the real application image.
#
# Week 2 CI/CD will:
#   1. Build the real Node.js image and push it to ECR
#   2. Run: aws ecs register-task-definition --cli-input-json file://task-def.json
#   3. Run: aws ecs update-service to deploy the new revision
#
# Fargate resource sizing (minimum):
#   CPU: 256 units (0.25 vCPU) — sufficient for a low-traffic portfolio app
#   Memory: 512 MiB — minimum allowed for 256 CPU in Fargate
#   See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html
#
# Secrets injection:
#   The `secrets` block in the container definition tells ECS to fetch the
#   secret value from Secrets Manager and inject it as an environment variable
#   BEFORE the container starts. The value never appears in the task definition
#   JSON or in CloudWatch Logs.
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-${var.environment}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # Required for Fargate; each task gets its own ENI

  cpu    = 256  # 0.25 vCPU
  memory = 512  # MiB

  # ECS uses the execution role to pull the image and inject secrets
  execution_role_arn = var.task_execution_role_arn

  # The application container assumes this role for any AWS SDK calls
  task_role_arn = var.task_role_arn

  # Container definitions — JSON encoded from HCL for readability
  container_definitions = jsonencode([
    {
      name  = "${var.project_name}-app"
      # Placeholder image — replaced by CI/CD in Week 2 with the real app image
      # from ECR: <account>.dkr.ecr.<region>.amazonaws.com/<project>-app:<sha>
      image = "nginx:alpine"

      essential = true # If this container stops, the task stops

      portMappings = [
        {
          # nginx listens on 80; Week 2 will change this to var.app_port (3000)
          # when the real app image replaces the placeholder
          containerPort = 80
          hostPort      = 80
          protocol      = "tcp"
        }
      ]

      # Secrets are fetched from Secrets Manager at container start and injected
      # as environment variables. The actual secret values never appear in the
      # task definition or deployment logs.
      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = var.db_secret_arn
        },
        {
          name      = "REDIS_URL"
          valueFrom = var.redis_secret_arn
        },
        {
          name      = "APP_SECRET"
          valueFrom = var.app_secret_arn
        }
      ]

      # Non-sensitive runtime configuration (safe to have in task definition)
      environment = [
        {
          name  = "NODE_ENV"
          value = var.environment
        },
        {
          name  = "PORT"
          value = tostring(var.app_port)
        }
      ]

      # Send all container stdout/stderr to CloudWatch Logs
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "app"
        }
      }

      # Health check — nginx serves a 200 on / by default
      # Week 2: replace with the real app's health endpoint (e.g., /health)
      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost/ || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60 # Grace period for app startup
      }
    }
  ])

  tags = {
    Name = "${var.project_name}-${var.environment}-task-def"
  }
}

# Data source: current AWS region (used in the awslogs-region log option)
data "aws_region" "current" {}
