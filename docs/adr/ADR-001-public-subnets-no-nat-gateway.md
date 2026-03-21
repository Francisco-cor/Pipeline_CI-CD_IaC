# ADR-001: Public Subnets Without NAT Gateway

## Status

Accepted

## Date

2026-03-20

## Context

This project deploys a Node.js + PostgreSQL application on AWS ECS Fargate with RDS as part of a portfolio/learning CI/CD pipeline project. The target environment is a developer sandbox using AWS Free Tier where possible.

### The Cost Problem

A standard production AWS architecture for ECS Fargate typically includes:

| Component | Monthly Cost |
|-----------|-------------|
| NAT Gateway (1 AZ) | ~$32/month ($0.045/hr + $0.045/GB data) |
| Application Load Balancer | ~$16/month ($0.008/LCU-hr + $0.0008/LCU) |
| **Total overhead** | **~$48/month** |

For a portfolio project generating zero revenue, $48/month in fixed networking overhead — before any compute or storage costs — is prohibitive. On a free-tier account this cost begins immediately and continues indefinitely.

### Why ECS Fargate Needs Internet Access

ECS Fargate tasks require outbound internet connectivity for three reasons:

1. **ECR image pulls** — pulling the application container image from Amazon ECR requires reaching the ECR API (`api.ecr.us-east-1.amazonaws.com`) and ECR DKR endpoint
2. **AWS API calls** — at startup, the task execution role calls Secrets Manager (`secretsmanager.us-east-1.amazonaws.com`) to inject secrets as environment variables
3. **CloudWatch Logs** — the `awslogs` log driver streams container output to CloudWatch Logs in real time

In a private-subnet architecture, this outbound traffic is routed through a NAT Gateway. Without a NAT Gateway, tasks in private subnets have no path to the internet or AWS APIs (unless VPC Interface Endpoints are added — see Alternatives Considered).

## Decision

Use **public subnets** for ECS Fargate tasks with `map_public_ip_on_launch = true`. Security is enforced exclusively at the Security Group level rather than at the network topology level.

### Security Architecture

```
Internet
    │
    │  inbound: 80, 443 only
    ▼
┌─────────────────────────────────────────┐
│  Public Subnet (10.0.1.0/24)            │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  ECS Task (sg_app)               │   │
│  │  - public IP assigned            │   │
│  │  - inbound: 80, 443 from 0.0.0.0 │   │
│  │  - outbound: all (ECR, SM, CW)   │   │
│  └────────────┬─────────────────────┘   │
│               │ 5432 (PostgreSQL)        │
│               ▼                          │
│  ┌──────────────────────────────────┐   │
│  │  RDS PostgreSQL (sg_db)          │   │
│  │  - publicly_accessible = false   │   │
│  │  - inbound: 5432 from sg_app ONLY│   │
│  │  - no outbound rules             │   │
│  └──────────────────────────────────┘   │
│               │ 6379 (Redis)             │
│               ▼                          │
│  ┌──────────────────────────────────┐   │
│  │  ElastiCache Redis (sg_redis)    │   │
│  │  - inbound: 6379 from sg_app ONLY│   │
│  │  - no outbound rules             │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### Load Balancer Replacement

Instead of an Application Load Balancer, an **nginx reverse proxy runs as a sidecar container** in the same ECS task as the Node.js application:

- nginx listens on port 80 (and 443 with a self-signed cert for local/dev)
- nginx proxies requests to the Node.js app on `localhost:3000`
- Both containers share the same network namespace (ECS `awsvpc` mode)
- The ECS task's public IP is accessed directly

This eliminates the ALB cost entirely while preserving the reverse-proxy pattern.

## Consequences

### Positive

- **Cost: $0/month** for networking overhead instead of ~$48/month
- **Simplicity**: fewer AWS components to provision, monitor, and troubleshoot
- **Free Tier compatibility**: public subnets with public IPs are fully free-tier compatible
- **Faster iteration**: no NAT Gateway provisioning delay (~3 minutes) during `terraform apply`

### Negative

- **ECS tasks have public IPs**: each Fargate task is assigned a public IP address. While security groups prevent unauthorized access, the IP is publicly routable and visible in `aws ecs describe-tasks`.
- **nginx sidecar coupling**: the reverse proxy and application share CPU/memory resources and scale as a unit. If the app needs horizontal scaling, the nginx sidecar scales with it (wasteful but functional at this traffic volume).
- **Not production-ready**: this architecture does not meet the security posture expected for production workloads handling real user data.
- **Multi-AZ complexity**: without a NAT Gateway or load balancer, traffic cannot be distributed across AZs. All tasks run with independent public IPs.

## Trade-offs Accepted

This is an explicit **FinOps decision** for a portfolio/development environment:

> We accept reduced network security posture (public IPs on ECS tasks, no private subnet isolation) in exchange for $0 fixed networking costs. Security is maintained through security group rules. This trade-off is appropriate for a non-production, zero-revenue portfolio project and would not be acceptable for any system handling sensitive user data or production traffic.

**This architecture must be revisited before any production use.** The migration path is:

1. Create private subnets
2. Add a NAT Gateway (or VPC endpoints for ECR/Secrets Manager/CloudWatch)
3. Migrate ECS tasks to private subnets
4. Add an Application Load Balancer
5. Remove the nginx sidecar (replace with ALB target group)

## Alternatives Considered

### 1. VPC Interface Endpoints for ECR and Secrets Manager

VPC Interface Endpoints allow private subnet resources to reach AWS services without a NAT Gateway or public internet.

| Endpoint | Cost |
|----------|------|
| `com.amazonaws.us-east-1.ecr.api` | $7.30/month |
| `com.amazonaws.us-east-1.ecr.dkr` | $7.30/month |
| `com.amazonaws.us-east-1.secretsmanager` | $7.30/month |
| `com.amazonaws.us-east-1.logs` | $7.30/month |
| **Total** | **$29.20/month** |

This would keep ECS tasks in private subnets (better security) but costs nearly as much as a NAT Gateway and is more complex to configure. **Rejected on cost grounds.**

### 2. NAT Gateway

The standard approach for private subnets. Costs ~$32/month minimum (one AZ) regardless of traffic volume. For a portfolio project this is an ongoing fixed cost with no business justification. **Rejected on cost grounds.**

### 3. Application Load Balancer

ALB provides path-based routing, SSL termination via ACM, health checks, and sticky sessions. Costs ~$16/month minimum. Without also having a NAT Gateway or VPC endpoints, ALB alone doesn't solve the outbound connectivity problem. **Rejected on cost grounds and because the nginx sidecar pattern achieves the same HTTP routing goal for free.**

### 4. Public Subnet + VPC Gateway Endpoints (Selected Architecture + Enhancement)

Gateway endpoints for S3 and DynamoDB are **free** and available. These are added as a no-cost enhancement to avoid routing S3/DynamoDB traffic through the internet gateway. Note: ECR uses S3 for layer storage, so the S3 gateway endpoint does reduce ECR data transfer costs for high-traffic environments.

## References

- [AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)
- [AWS NAT Gateway Pricing](https://aws.amazon.com/vpc/pricing/)
- [AWS VPC Endpoints Pricing](https://aws.amazon.com/privatelink/pricing/)
- [AWS Well-Architected Framework — Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [AWS Well-Architected Framework — Security Pillar: Network Protection](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/protecting-networks.html)
- [Terraform S3 Backend Documentation](https://developer.hashicorp.com/terraform/language/backend/s3)
