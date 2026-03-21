# ERP Pipeline — CI/CD with IaC, Secrets Management, and Auto-Rollback

![CI/CD](https://github.com/YOUR_USERNAME/Pipeline_CI-CD_IaC/actions/workflows/pipeline.yml/badge.svg)

Node.js microservices deployed to AWS ECS Fargate with Terraform IaC. A GitHub Actions pipeline runs lint → test → build → deploy on every push to `main`. If the health check fails post-deploy, ECS rolls back automatically to the previous revision.

---

## Architecture

```mermaid
graph TB
    subgraph GitHub
        DEV[Developer Push] --> GHA[GitHub Actions]
    end

    subgraph Pipeline["CI/CD Pipeline (pipeline.yml)"]
        GHA --> L[1. Lint\nESLint]
        L --> T[2. Test\nJest + real Postgres]
        T --> B[3. Build\nDocker → ECR]
        B --> D[4. Deploy\nECS task def update]
    end

    subgraph AWS
        subgraph VPC["VPC 10.0.0.0/16"]
            subgraph PubSubnet["Public Subnet (ADR-001)"]
                subgraph Task["ECS Fargate Task (0.5 vCPU / 1 GB)"]
                    NGX["nginx :80\n(reverse proxy)"]
                    MIG["migrations\n(init container)"]
                    P["svc-productos :3001"]
                    O["svc-ordenes :3002"]
                    S["svc-stock :3003"]
                end
            end
            RDS[("RDS PostgreSQL 15\ndb.t3.micro")]
            REDIS[("ElastiCache Redis 7\ncache.t3.micro")]
        end

        ECR["ECR\n5 repositories"]
        SM["Secrets Manager\n/erp/db-url\n/erp/redis-url\n/erp/app-secret"]
        CW["CloudWatch Logs\n7-day retention\nerror rate alarm"]
        SNS["SNS\nalert email"]
    end

    NGX --> P & O & S
    MIG -. "dependsOn SUCCESS" .-> P & O & S
    Task -- "SELECT 1" --> RDS
    Task --> REDIS
    Task -- "at startup" --> SM
    Task -- "stdout JSON" --> CW
    CW -- "> 10 errors / 5 min" --> SNS
    ECR --> Task
    D --> Task
```

**Traffic path:** Internet → ECS public IP :80 → nginx → services on localhost (shared task network namespace).
No ALB, no NAT Gateway — see [ADR-001](docs/adr/ADR-001-public-subnets-no-nat-gateway.md).

---

## Free Tier Cost Breakdown

| Service | Instance | Hours/month | Cost |
|---------|----------|-------------|------|
| ECS Fargate | 0.5 vCPU · 1 GB | 720 h (< 750 h limit) | **$0** |
| RDS PostgreSQL | db.t3.micro · 20 GiB | 720 h (< 750 h limit) | **$0** |
| ElastiCache | cache.t3.micro | 720 h (< 750 h limit) | **$0** |
| ECR | 5 repos · ~150 MB total | — | **$0** (< 500 MB) |
| CloudWatch Logs | 7-day retention | — | **$0** (< 5 GB/mo) |
| ALB | — | eliminated | **$0** (nginx sidecar) |
| NAT Gateway | — | eliminated | **$0** (public subnets) |
| **Total** | | | **~$0 / month** |

*Free Tier applies to first 12 months of a new AWS account.*

---

## Services

| Service | Port | Routes |
|---------|------|--------|
| svc-productos | 3001 | `GET /productos`, `POST /productos`, `GET /health` |
| svc-ordenes | 3002 | `GET /ordenes`, `POST /ordenes`, `GET /health` |
| svc-stock | 3003 | `GET /stock`, `POST /stock`, `GET /health` |

All services are proxied through nginx:

```
GET /api/productos/* → svc-productos:3001
GET /api/ordenes/*   → svc-ordenes:3002
GET /api/stock/*     → svc-stock:3003
GET /health          → nginx 200 OK
```

---

## Pipeline

```
push to main
    │
    ▼
 lint ──────── ESLint on all three services
    │
    ▼
 test ──────── Jest + real PostgreSQL service container
    │           Migrations run before suites
    │           DB-dependent tests: health, CRUD
    ▼
 build ─────── Docker build → ECR push (sha-<commit> + :latest)
    │           AWS auth via OIDC — zero stored credentials
    ▼
 deploy ─────── Register new ECS task definition revision
                Update ECS service → wait for stable
                If health checks fail: ECS auto-rollback ↩
```

GitHub Actions uses OIDC to assume an AWS IAM role — no `AWS_ACCESS_KEY_ID` stored anywhere. See [ADR-002](docs/adr/ADR-002-oidc-github-actions.md).

---

## Deploy from scratch

### Prerequisites

- AWS CLI configured (`aws configure`)
- Terraform >= 1.5
- Docker running
- `bash`, `python3`, `git`

### 1. Bootstrap Terraform remote state

```bash
chmod +x scripts/bootstrap-backend.sh
./scripts/bootstrap-backend.sh erp-pipeline dev us-east-1
```

### 2. Apply infrastructure

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars:
#   github_repo = "your-username/Pipeline_CI-CD_IaC"
#   alert_email = "you@example.com"   # optional

terraform init \
  -backend-config="bucket=erp-pipeline-dev-tfstate" \
  -backend-config="dynamodb_table=erp-pipeline-dev-tflock" \
  -backend-config="region=us-east-1"

terraform plan
terraform apply
```

### 3. Configure GitHub secret

```bash
# Copy this output value:
terraform output github_actions_role_arn
```

In the GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `AWS_ROLE_ARN`
- Value: paste the ARN from the previous step

### 4. Push to trigger the pipeline

```bash
git push origin main
# Pipeline runs automatically: lint → test → build → deploy
```

### 5. Test the deployment

```bash
# Get the ECS task public IP
CLUSTER=erp-pipeline-dev-cluster
TASK_ARN=$(aws ecs list-tasks --cluster $CLUSTER --query 'taskArns[0]' --output text)
ENI_ID=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK_ARN \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)
PUBLIC_IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

curl http://$PUBLIC_IP/health
curl http://$PUBLIC_IP/api/productos/health
curl http://$PUBLIC_IP/api/ordenes/health
curl http://$PUBLIC_IP/api/stock/health
```

### Tear down (no orphan resources)

```bash
cd terraform
terraform destroy
# S3 bucket and DynamoDB table (state backend) must be deleted manually if desired
```

---

## Local development

```bash
# Start all services with a local Postgres
docker compose up

# Run tests (requires DATABASE_URL)
cd services/productos
DATABASE_URL=postgresql://erpadmin:dev_pass@localhost:5432/erpdb npm test

# Lint
npm run lint
```

---

## ADRs

| # | Decision |
|---|----------|
| [ADR-001](docs/adr/ADR-001-public-subnets-no-nat-gateway.md) | Public subnets + nginx sidecar instead of NAT Gateway + ALB (~$48/mo savings) |
| [ADR-002](docs/adr/ADR-002-oidc-github-actions.md) | OIDC for GitHub Actions instead of long-lived IAM access keys |

---

## Key design decisions

**Rollback is automatic.** The ECS deployment circuit breaker (`rollback = true` in Terraform) rolls back to the previous task definition revision if health checks fail after deploy. The pipeline never ships broken code to production — tests catch most issues, and ECS catches the rest.

**Zero secrets in the repo or CI config.** Database credentials are generated at `terraform apply` time via `random_password` and stored in Secrets Manager. The ECS task execution role fetches them at container startup. GitHub Actions authenticates via OIDC — no static keys anywhere.

**Cost-optimized for free tier.** All three services run as containers in a single ECS task (shared 0.5 vCPU / 1 GB), counting as one Fargate instance. nginx replaces ALB. Public subnets replace NAT Gateway. Total AWS cost: ~$0/month for the first year.
