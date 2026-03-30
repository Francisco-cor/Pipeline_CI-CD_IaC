# modules/compute/main.tf
#
# Week 2: Multi-container task definition + ECS Service
#
# Containers in the task:
#   1. migrations — init container (essential: false). Runs SQL migrations and exits.
#      All other containers wait for this to exit 0 (dependsOn: SUCCESS condition).
#   2. nginx      — reverse proxy on port 80. Routes /api/X → svc-X:3001/2/3.
#   3. productos  — Node.js service on port 3001
#   4. ordenes    — Node.js service on port 3002
#   5. stock      — Node.js service on port 3003
#
# Task sizing: 512 CPU (0.5 vCPU) / 1024 MB (1 GB)
#   Within Fargate free tier: 750 vCPU-hours/month
#   0.5 vCPU × 24h × 30d = 360 hours → well within free tier
#
# ECS Service: desired_count = 1, auto-scaling disabled, deployment_circuit_breaker enabled.
# If the new task fails health checks within the grace period, ECS automatically
# rolls back to the previous task definition revision. This is the rollback mechanism.

# --- ECR Repositories (one per service) ---

# ECR repos: one per service + nginx + migrations
# Each service gets its own repository for independent image lifecycle management.
# ECR free tier: 500 MB/month. Our images are ~150 MB total so we stay in free tier.

locals {
  services = ["productos", "ordenes", "stock", "nginx", "migrations"]
}

resource "aws_ecr_repository" "services" {
  for_each = toset(local.services)

  name                 = "${var.project_name}-${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-${each.key}"
  }
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name

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
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 1 tagged images for rollback capability"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-", "v", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 1
        }
        action = { type = "expire" }
      }
    ]
  })
}

# --- ECS Cluster ---

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

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 1
    capacity_provider = "FARGATE"
  }
}

# --- CloudWatch Log Group ---

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}"
  retention_in_days = 30

  tags = {
    Name = "/ecs/${var.project_name}-${var.environment}"
  }
}

# --- Multi-container Task Definition ---

locals {
  # ECR base URL used in container image references.
  # deploy.sh pushes images with :sha-<git_sha> tags.
  # The Terraform task definition uses :latest as a placeholder.
  # CI/CD registers new task definition revisions with :sha-<git_sha> — never mutating
  # the Terraform-managed task definition.
  ecr_base = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"

  # Common log configuration for all containers
  log_config = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
      "awslogs-region"        = data.aws_region.current.name
      "awslogs-stream-prefix" = "ecs"
    }
  }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-${var.environment}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  # 0.5 vCPU / 1 GB — fits all 5 containers within free tier
  cpu    = 512
  memory = 1024

  execution_role_arn = var.task_execution_role_arn
  task_role_arn      = var.task_role_arn

  container_definitions = jsonencode([
    # -------------------------------------------------------------------------
    # Container 1: migrations (init container)
    #
    # essential = false: ECS does not restart this container when it exits.
    # Exit 0 → condition "SUCCESS" → other containers start.
    # Exit non-0 → condition "SUCCESS" not met → task fails → circuit breaker fires.
    # This guarantees: never a service running with an outdated schema.
    # -------------------------------------------------------------------------
    {
      name      = "migrations"
      image     = "${local.ecr_base}/${var.project_name}-migrations:latest"
      essential = false  # Exits after running — task continues if exit code is 0

      secrets = [
        { name = "DATABASE_URL", valueFrom = var.db_secret_arn }
      ]

      environment = [
        { name = "NODE_ENV", value = var.environment }
      ]

      logConfiguration = local.log_config
    },

    # -------------------------------------------------------------------------
    # Container 2: nginx (reverse proxy — replaces ALB, see ADR-001)
    #
    # Listens on port 80. Routes:
    #   /api/productos/* → localhost:3001
    #   /api/ordenes/*   → localhost:3002
    #   /api/stock/*     → localhost:3003
    #   /health          → 200 (nginx health check for ECS)
    #
    # dependsOn migrations with condition SUCCESS — nginx doesn't start until
    # migrations have run, preventing requests before schema is ready.
    # -------------------------------------------------------------------------
    {
      name      = "nginx"
      image     = "${local.ecr_base}/${var.project_name}-nginx:latest"
      essential = true

      dependsOn = [
        { containerName = "migrations", condition = "SUCCESS" }
      ]

      portMappings = [
        { containerPort = 80, hostPort = 80, protocol = "tcp" }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 120
      }

      logConfiguration = merge(local.log_config, {
        options = merge(local.log_config.options, { "awslogs-stream-prefix" = "nginx" })
      })
    },

    # -------------------------------------------------------------------------
    # Container 3: svc-productos (Node.js, port 3001)
    # -------------------------------------------------------------------------
    {
      name      = "svc-productos"
      image     = "${local.ecr_base}/${var.project_name}-productos:latest"
      essential = true

      dependsOn = [
        { containerName = "migrations", condition = "SUCCESS" }
      ]

      environment = [
        { name = "NODE_ENV",     value = var.environment },
        { name = "PORT",         value = "3001" },
        { name = "SERVICE_NAME", value = "svc-productos" }
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = var.db_secret_arn }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 120
      }

      logConfiguration = merge(local.log_config, {
        options = merge(local.log_config.options, { "awslogs-stream-prefix" = "productos" })
      })
    },

    # -------------------------------------------------------------------------
    # Container 4: svc-ordenes (Node.js, port 3002)
    # -------------------------------------------------------------------------
    {
      name      = "svc-ordenes"
      image     = "${local.ecr_base}/${var.project_name}-ordenes:latest"
      essential = true

      dependsOn = [
        { containerName = "migrations", condition = "SUCCESS" }
      ]

      environment = [
        { name = "NODE_ENV",     value = var.environment },
        { name = "PORT",         value = "3002" },
        { name = "SERVICE_NAME", value = "svc-ordenes" }
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = var.db_secret_arn }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:3002/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 120
      }

      logConfiguration = merge(local.log_config, {
        options = merge(local.log_config.options, { "awslogs-stream-prefix" = "ordenes" })
      })
    },

    # -------------------------------------------------------------------------
    # Container 5: svc-stock (Node.js, port 3003)
    # -------------------------------------------------------------------------
    {
      name      = "svc-stock"
      image     = "${local.ecr_base}/${var.project_name}-stock:latest"
      essential = true

      dependsOn = [
        { containerName = "migrations", condition = "SUCCESS" }
      ]

      environment = [
        { name = "NODE_ENV",     value = var.environment },
        { name = "PORT",         value = "3003" },
        { name = "SERVICE_NAME", value = "svc-stock" }
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = var.db_secret_arn }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:3003/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 120
      }

      logConfiguration = merge(local.log_config, {
        options = merge(local.log_config.options, { "awslogs-stream-prefix" = "stock" })
      })
    }
  ])

  tags = {
    Name = "${var.project_name}-${var.environment}-task-def"
  }
}

# --- ECS Service ---
#
# desired_count = 1: single task for free tier.
# To scale: change desired_count and enable the auto-scaling block below.
#
# deployment_circuit_breaker: ECS tracks the rolling deployment.
# If the new task fails health checks after health_check_grace_period_seconds,
# ECS marks the task as unhealthy. After `failure_threshold` consecutive failures,
# the circuit breaker fires and ECS rolls back to the PREVIOUS task definition
# revision automatically. No script needed — this IS the rollback mechanism.
#
# lifecycle ignore_changes: Terraform manages the service configuration but NOT
# which task definition revision is running. CI/CD (deploy.sh / GitHub Actions)
# registers new revisions and updates the service. Without this, `terraform apply`
# would revert the service back to the Terraform-managed revision on every run.

resource "aws_ecs_service" "app" {
  name            = "${var.project_name}-${var.environment}-service"
  cluster         = aws_ecs_cluster.main.arn
  task_definition = aws_ecs_task_definition.app.arn

  # Free tier: 1 task running.
  # Interview answer: "To scale, change desired_count and enable the
  # aws_appautoscaling_target block in modules/compute/main.tf (currently commented out)."
  desired_count = 1

  # Use regular FARGATE (not SPOT) for the single task — SPOT can be interrupted,
  # which is unacceptable when desired_count = 1 (no redundancy).
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.sg_app_id]
    # assign_public_ip = true is REQUIRED because we use public subnets without
    # a NAT Gateway. ECS needs the public IP to reach ECR and Secrets Manager.
    # See ADR-001 for the cost/security trade-off decision.
    assign_public_ip = true
  }

  # The rollback mechanism.
  # If the new task doesn't pass health checks within health_check_grace_period_seconds,
  # ECS marks the deployment as failed and reverts to the previous task definition.
  deployment_circuit_breaker {
    enable   = true
    rollback = true   # This is the automatic rollback — no script, ECS handles it
  }

  deployment_controller {
    type = "ECS"  # Rolling deployment. Blue/green would use CODE_DEPLOY.
  }

  # Grace period: time ECS waits before starting health check evaluation.
  # 120s covers: container startup + migrations + DB connection pool warmup,
  # with margin for cold RDS starts that previously caused false rollbacks at 60s.
  health_check_grace_period_seconds = 120

  lifecycle {
    # CI/CD updates task_definition — don't let terraform apply revert it.
    # Also ignore desired_count — allows manual scaling without Terraform drift.
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-service"
  }

  depends_on = [aws_ecs_cluster.main]
}

# --- Auto-scaling (DISABLED for free tier) ---
#
# Uncomment to enable. In an interview: "Auto-scaling is already designed in.
# To activate: uncomment this block and set desired_count = 2 minimum."
#
# resource "aws_appautoscaling_target" "ecs_service" {
#   max_capacity       = 4
#   min_capacity       = 1
#   resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
#   scalable_dimension = "ecs:service:DesiredCount"
#   service_namespace  = "ecs"
# }
#
# resource "aws_appautoscaling_policy" "cpu" {
#   name               = "${var.project_name}-${var.environment}-cpu-scaling"
#   policy_type        = "TargetTrackingScaling"
#   resource_id        = aws_appautoscaling_target.ecs_service.resource_id
#   scalable_dimension = aws_appautoscaling_target.ecs_service.scalable_dimension
#   service_namespace  = aws_appautoscaling_target.ecs_service.service_namespace
#
#   target_tracking_scaling_policy_configuration {
#     target_value       = 70.0
#     predefined_metric_specification {
#       predefined_metric_type = "ECSServiceAverageCPUUtilization"
#     }
#   }
# }
