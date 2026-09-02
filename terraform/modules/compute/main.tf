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
        description  = "Keep last ${var.ecr_image_retention_count} tagged images for rollback (Fase 7.5)"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-", "v", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = var.ecr_image_retention_count
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

# --- CloudWatch Log Group (Fase 9.2 — retention per env) ---

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}"
  retention_in_days = var.environment == "prod" ? 90 : var.environment == "staging" ? 14 : 7

  tags = {
    Name = "/ecs/${var.project_name}-${var.environment}"
  }
}


# --- Service Discovery (Cloud Map) � Fase 7.6 ---
# Private DNS namespace erp.local para http://productos.erp.local:3001 etc.
# Habilitado solo si var.enable_service_discovery=true (staging/prod).
# En dev (false) no se crea nada � coste $0. Fase 10 usara esto para
# desacoplar ordenes->productos via HTTP con circuit breaker en vez de SELECT directo.
resource "aws_service_discovery_private_dns_namespace" "erp" {
  count       = var.enable_service_discovery ? 1 : 0
  name        = "erp.local"
  description = "Fase 7.6 � Cloud Map private DNS for ${var.project_name} ${var.environment}"
  vpc         = var.vpc_id
  tags = {
    Name = "${var.project_name}-${var.environment}-erp-local"
  }
}

resource "aws_service_discovery_service" "services" {
  for_each = var.enable_service_discovery ? toset(["productos", "ordenes", "stock"]) : toset([])

  name = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.erp[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-${each.key}"
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
  # Fase 10: si enable_alb, podría necesitar más memoria para sidecars adicionales
  cpu    = 512
  memory = 1024

  execution_role_arn = var.task_execution_role_arn
  task_role_arn      = var.task_role_arn

  container_definitions = templatefile("${path.module}/templates/taskdef.json.tftpl", {
    ecr_base      = local.ecr_base
    project_name  = var.project_name
    environment   = var.environment
    db_secret_arn = var.db_secret_arn
    log_group     = aws_cloudwatch_log_group.ecs.name
    region        = data.aws_region.current.name
    # Fase 10 envs
    redis_url      = var.redis_url
    sqs_queue_url  = var.sqs_queue_url
    productos_url  = var.enable_service_discovery ? "http://productos.erp.local:3001" : "http://127.0.0.1:3001"
    cache_ttl      = "30"
    enable_tracing = "false"
  })

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

  # Free tier: 1 task running. Fase 10: cuando enable_autoscaling=true, min=var.autoscaling_min_capacity, max=4, escalado por CPU 70%.
  desired_count = var.enable_autoscaling ? var.autoscaling_min_capacity : 1

  # Use regular FARGATE (not SPOT) for the single task — SPOT can be interrupted,
  # which is unacceptable when desired_count = 1 (no redundancy).
  # Fase 10: si enable_autoscaling y spot disponible, podría usar FARGATE_SPOT weight bajo.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [var.sg_app_id]
    # FinOps: true para public subnets. Prod con NAT+private documentado en ADR-004 (false allí).
    assign_public_ip = true
  }

  # Fase 10.4 — ALB attachment (opcional). NGINX sigue siendo target (port 80).
  dynamic "load_balancer" {
    for_each = var.enable_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.app[0].arn
      container_name   = "nginx"
      container_port   = 80
    }
  }

  # The rollback mechanism.
  # If the new task doesn't pass health checks within health_check_grace_period_seconds,
  # ECS marks the deployment as failed and reverts to the previous task definition.
  deployment_circuit_breaker {
    enable   = true
    rollback = true # This is the automatic rollback — no script, ECS handles it
  }

  deployment_controller {
    type = "ECS" # Rolling deployment. Blue/green would use CODE_DEPLOY.
  }

  # Grace period: time ECS waits before starting health check evaluation.
  # 120s covers: container startup + migrations + DB connection pool warmup,
  # with margin for cold RDS starts that previously caused false rollbacks at 60s.
  # Fase 10 con ALB: TG health check también necesita grace.
  health_check_grace_period_seconds = 120

  lifecycle {
    # CI/CD updates task_definition — don't let terraform apply revert it.
    # Also ignore desired_count when autoscaling disabled; con autoscaling, ignore es manejado por autoscaling target.
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-service"
  }

  depends_on = [aws_ecs_cluster.main]
}

# --- Auto-scaling (Fase 10.3 — toggle var.enable_autoscaling) ---
# FinOps false: sin auto-scaling (desired 1). Prod true: target tracking CPU 70% + memoria 80% + ALB 1000 req
resource "aws_appautoscaling_target" "ecs" {
  count              = var.enable_autoscaling ? 1 : 0
  max_capacity       = var.autoscaling_max_capacity
  min_capacity       = var.autoscaling_min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.enable_autoscaling ? 1 : 0
  name               = "${var.project_name}-${var.environment}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 70.0
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "memory" {
  count              = var.enable_autoscaling ? 1 : 0
  name               = "${var.project_name}-${var.environment}-mem-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 80.0
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
  }
}

# --- ALB (Fase 10.4 — toggle var.enable_alb, cost ~$16/mo) ---
# Cuando false (default dev FinOps), no se crea nada — solo nginx sidecar.
# Cuando true (prod), crea ALB público en public subnets + TG -> nginx:80 + listeners.
resource "aws_security_group" "alb" {
  count       = var.enable_alb ? 1 : 0
  name        = "${var.project_name}-${var.environment}-sg-alb"
  description = "ALB SG — 80/443 from internet, egress to app SG 80"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "to app SG 80"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [var.sg_app_id]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-sg-alb"
  }
}

# Regla SG app: permite tráfico desde ALB SG a nginx 80 (solo cuando ALB habilitado)
resource "aws_security_group_rule" "app_from_alb" {
  count                    = var.enable_alb ? 1 : 0
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = var.sg_app_id
  source_security_group_id = aws_security_group.alb[0].id
  description              = "Fase 10.4 - ALB to app nginx 80"
}

resource "aws_lb" "main" {
  count              = var.enable_alb ? 1 : 0
  name               = "${var.project_name}-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = false

  tags = {
    Name = "${var.project_name}-${var.environment}-alb"
  }
}

resource "aws_lb_target_group" "app" {
  count       = var.enable_alb ? 1 : 0
  name        = "${var.project_name}-${var.environment}-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-tg"
  }
}

resource "aws_lb_listener" "http" {
  count             = var.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_alb && var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.acm_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}
