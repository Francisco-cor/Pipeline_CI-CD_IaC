# -----------------------------------------------------------------------------
# modules/networking/main.tf
#
# Creates the foundational network layer:
#   - VPC
#   - Public subnets (one per AZ)
#   - Internet Gateway + route table
#   - Security groups for app and database
#
# Design decision — public subnets without NAT Gateway:
#   See docs/adr/ADR-001-public-subnets-no-nat-gateway.md for the full
#   rationale. TL;DR: NAT Gateway costs ~$32/month; for a dev/portfolio
#   environment we use public subnets with security groups as the security
#   perimeter instead.
#
# VPC Endpoints (NOT created here):
#   Interface endpoints for ecr.api, ecr.dkr, and secretsmanager would allow
#   private ECR pulls and Secrets Manager calls without internet traffic.
#   However, each interface endpoint costs ~$7.30/month (730 hrs × $0.01/hr).
#   For this free-tier project we skip them and rely on the public internet
#   path (ECS tasks get public IPs). In production, add VPC endpoints or use
#   a NAT Gateway.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# VPC
# -----------------------------------------------------------------------------
resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # enable_dns_hostnames is required for RDS to resolve its own hostname and
  # for ECS tasks to resolve ECR/AWS API endpoints via public DNS.
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.project_name}-${var.environment}-vpc"
  }
}

# -----------------------------------------------------------------------------
# Public subnets — one per AZ
#
# We create subnets dynamically from the availability_zones variable so that
# adding a third AZ in the future is a one-line tfvars change.
# CIDR blocks: 10.0.1.0/24, 10.0.2.0/24, ... (index + 1 to avoid 10.0.0.0/24)
# -----------------------------------------------------------------------------
resource "aws_subnet" "public" {
  # One subnet per AZ supplied in var.availability_zones
  for_each = { for idx, az in var.availability_zones : az => idx }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key

  # Offset by 1 so the first subnet is 10.0.1.0/24, not 10.0.0.0/24.
  # 10.0.0.0/24 is reserved as a potential future management/bastion subnet.
  cidr_block = cidrsubnet(var.vpc_cidr, 8, each.value + 1)

  # map_public_ip_on_launch = true is required because we use public subnets
  # instead of a NAT Gateway. ECS tasks need a public IP to reach ECR and
  # the Secrets Manager API. Security is enforced by sg_app (see below).
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-${var.environment}-public-${each.key}"
    Tier = "public"
  }
}

# -----------------------------------------------------------------------------
# Internet Gateway — provides the VPC's path to the internet
# -----------------------------------------------------------------------------
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-${var.environment}-igw"
  }
}

# -----------------------------------------------------------------------------
# Route table — default route to the Internet Gateway
# -----------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-public-rt"
  }
}

# Associate every public subnet with the shared route table
resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# -----------------------------------------------------------------------------
# Security Group: sg_app
#
# Attached to ECS Fargate tasks.
# Inbound: HTTP (80) and HTTPS (443) from anywhere — the nginx sidecar handles
#          TLS termination and proxies to the Node.js app on port 3000.
# Outbound: all traffic — needed to pull images from ECR, call Secrets Manager,
#           write logs to CloudWatch, and connect to RDS/Redis within the VPC.
# -----------------------------------------------------------------------------
resource "aws_security_group" "sg_app" {
  name        = "${var.project_name}-${var.environment}-sg-app"
  description = "App tier: allows HTTP/HTTPS inbound; all outbound for AWS API calls and ECR pulls."
  vpc_id      = aws_vpc.main.id

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

  # Allow all outbound traffic so ECS can reach:
  #   - ECR (image pulls)
  #   - Secrets Manager (secret fetching at startup)
  #   - CloudWatch Logs (log shipping)
  #   - RDS (within the VPC)
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-sg-app"
  }
}

# -----------------------------------------------------------------------------
# Security Group: sg_db
#
# Attached to the RDS PostgreSQL instance.
# Inbound: PostgreSQL (5432) ONLY from sg_app — never from the internet.
# Outbound: none (RDS does not initiate connections).
#
# Even though the RDS instance is in a public subnet (see ADR-001), this SG
# ensures it is not reachable from the public internet.
# -----------------------------------------------------------------------------
resource "aws_security_group" "sg_db" {
  name        = "${var.project_name}-${var.environment}-sg-db"
  description = "DB tier: PostgreSQL access restricted to sg_app only. No internet access."
  vpc_id      = aws_vpc.main.id

  ingress {
    description              = "PostgreSQL from app tier only"
    from_port                = 5432
    to_port                  = 5432
    protocol                 = "tcp"
    source_security_group_id = aws_security_group.sg_app.id
  }

  # No egress rule = implicit deny all outbound (RDS never initiates connections)

  tags = {
    Name = "${var.project_name}-${var.environment}-sg-db"
  }
}

