# cache.tf — Fase 10.5 Redis (ElastiCache) para productos cache
# Toggle var.enable_redis (default false $0). Cuando true crea ElastiCache Redis en private o public subnets.
# Nota prod: recomendado enable_nat_gateway=true + private subnets; si false, usa public (menos seguro pero funcional dev).

locals {
  redis_subnet_ids = var.enable_nat_gateway ? module.networking.private_subnet_ids : module.networking.public_subnet_ids
}

resource "aws_elasticache_subnet_group" "redis" {
  count       = var.enable_redis ? 1 : 0
  name        = "${var.project_name}-${var.environment}-redis-subnet"
  subnet_ids  = local.redis_subnet_ids
  description = "Fase 10.5 - Redis subnet group (${var.environment})"
}

resource "aws_security_group" "redis" {
  count       = var.enable_redis ? 1 : 0
  name        = "${var.project_name}-${var.environment}-sg-redis"
  description = "Redis 6379 solo desde sg_app"
  vpc_id      = module.networking.vpc_id

  ingress {
    description     = "Redis from app tier only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.networking.sg_app_id]
  }

  egress {
    description = "no egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-sg-redis"
  }
}

resource "aws_elasticache_cluster" "redis" {
  count                = var.enable_redis ? 1 : 0
  cluster_id           = "${var.project_name}-${var.environment}-redis"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  engine_version       = "7.0"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.redis[0].name
  security_group_ids   = [aws_security_group.redis[0].id]

  tags = {
    Name = "${var.project_name}-${var.environment}-redis"
  }
}
