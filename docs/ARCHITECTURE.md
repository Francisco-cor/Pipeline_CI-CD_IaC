# Architecture — ERP Pipeline

> Mapa rápido del repo. Para decisiones con trade-off ver `docs/adr/`.

## Stack (resumen)

- **Runtime:** Node 20 + Express 4 + `pg` 8, PostgreSQL 15 en RDS `db.t3.micro`.
- **Infra:** AWS ECS Fargate (task 0.5 vCPU/1GB), ECR, RDS, SSM Parameter Store, CloudWatch, SNS, ElastiCache/SQS opcionales (Fase 10).
- **IaC:** Terraform 1.9+ modular (`terraform/modules/*`), backend S3+DynamoDB per env (`terraform/backend.tf:1-20` `encrypt=true` + `environments/backend-*.hcl:1` + `environments/*.tfvars:1`), `terraform/.tflint.hcl:1` + `checkov`, toggles `enable_nat_gateway/service_discovery/alb/autoscaling/redis/sqs` (Fase 7+10).
- **CI/CD:** GitHub Actions OIDC (`terraform/cicd.tf:17-65`, `ADR-002`), `concurrency` + `paths-filter` + `lint --cache` + `gitleaks/trivy` + `tflint/checkov` + `buildx gha cache` + `coverage` (`pipeline.yml:18-711`, `release.yml:1`) — Fase 6 (<6m PR), `teardown.yml:15-60` prod guard (Fase 7.8), `semantic-release` (`package.json:12`, `.releaserc.json:1`) Fase 11.6.
- **Proxy:** NGINX sidecar (`nginx/nginx.conf:1-96`) en misma task ECS (awsvpc, `localhost`) — + ALB opcional Fase 10.4 (`compute/main.tf:320`) + BFF `gateway:3004` (`nginx.conf:102` Fase 11.1).
- **Cache/Queue:** Redis `ioredis` + memory fallback (`cache.js:1`), SQS `@aws-sdk/client-sqs` (`queue.js:1`) — Fase 10.5/10.6.
- **Frontend/BFF:** `frontend/{index.html,app.js,styles.css}` static dashboard `http://localhost:8080` + `services/gateway/src/index.js:1` `svc-gateway` `GET /bff/ordenes/:id` (`X-Request-Id`, circuit, BFF aggregation `ordenes.js:152` Fase 11) + OpenAPI 3.1 `docs/openapi.yaml:1` + `docs/api.md:1`.

## Layout

```
.
├── services/{productos,ordenes,stock,gateway}/src/
│   ├── index.js        # express app + graceful SIGTERM (gateway svc-gateway BFF 3004 Fase 11.1)
│   ├── db.js           # pg Pool (max 3, ssl auto)
│   ├── logger.js       # JSON stdout → CloudWatch
│   ├── routes/{health,*.js}  # ordenes → GET /:id?include=producto BFF aggregation
│   └── __tests__/health.test.js
├── frontend/{index.html,app.js,styles.css,Dockerfile,README.md}  # Fase 11.2 static dashboard http://localhost:8080 --profile frontend
├── migrations/{run.js, sql/001_*.sql ..}
├── nginx/{nginx.conf, nginx.local.conf, Dockerfile}  # Fase 11.1 BFF location /api/v1/bff/ordenes/:id
├── terraform/
│   ├── main.tf               # compone networking → database → secrets → compute (locals is_prod, sqs_queue_url, redis_url)
│   ├── variables.tf          # toggles Fase 7+10: enable_nat_gateway/deletion_protection/service_discovery/alb/autoscaling/redis/sqs
│   ├── sqs.tf                # Fase 10.6 SQS ordenes + DLQ (enable_sqs)
│   ├── cache.tf              # Fase 10.5 ElastiCache Redis (enable_redis)
│   ├── modules/{networking,database,secrets,compute}
│   │   └── compute/templates/taskdef.json.tftpl  # Fase 7.4 templatefile + Fase 10 REDIS_URL/SQS/PRODUCTOS_URL
│   ├── environments/         # Fase 7.1: dev/staging/prod.tfvars + backend-*.hcl per env
│   │   ├── dev.tfvars + backend-dev.hcl
│   │   ├── staging.tfvars + backend-staging.hcl
│   │   └── prod.tfvars + backend-prod.hcl
│   ├── cicd.tf               # OIDC provider + role (github_actions)
│   ├── observability.tf      # metric filter + alarm (Fase 9.5)
│   ├── dashboard.tf          # 6 widgets (Fase 9.4)
│   └── backend.tf            # S3 partial config encrypt=true (Fase 7.1 — supply via -backend-config)
├── scripts/{build.sh,deploy.sh,chaos.sh,k6/{smoke,resilience}.js,bootstrap-backend.{sh,ps1}}
├── .releaserc.json            # Fase 11.6 semantic-release (commit-analyzer/changelog/github/git)
├── CHANGELOG.md               # Fase 11.6 Keep a Changelog conventional commits
└── docs/{adr/{ADR-004..006},ARCHITECTURE.md,api.md,openapi.yaml,interview.md,demo.md,observability.md,runbooks/{deploy,rollback,drift}.md}
```

## Flujo de request

```
# FinOps (enable_alb=false): Internet → ECS public IP:80 → NGINX (rate 30r/s) → svc-productos:3001 | svc-ordenes:3002 | svc-stock:3003
# Prod (enable_alb=true + enable_nat_gateway=true): Internet → ALB (80/443 ACM) → ECS private IP:80 (TG nginx) → svc-*

Internet → [ALB*] → NGINX (rate 30r/s) → svc-productos:3001 | svc-ordenes:3002 | svc-stock:3003
                          → /health 200 (nginx)
                          → /api/{productos,ordenes,stock}/health → upstream health
                          → /api/{productos,ordenes,stock}(/*) → proxy_pass http://X/X$1
Migrations (init, essential:false, SUCCESS) bloquea resto hasta exit 0
RDS (sg_db:5432 solo desde sg_app) ← servicios; SSM → DATABASE_URL inyectado al inicio
Redis (sg_redis:6379 desde sg_app, ElastiCache toggle Fase 10.5) ← productos/stock cache
SQS (ordenes queue + DLQ Fase 10.6) ← ordenes publish, stock consume opcional POLL_SQS
```

Ver `README.md:29-76` (mermaid) y `ADR-001` para coste $0 (public subnets sin NAT).

## Módulos Terraform (Fase 7 + 10)

| Módulo                                                     | Crea                                                                                                                                                                                                                                                          | Clave                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `networking` (`modules/networking/main.tf:27-251`)         | VPC `10.0.0.0/16`, 2 public subnets `10.0.1/24-2/24` + opcional 2 private `10.0.10/24-11/24` + IGW + NAT GW/EIP + route tables public/private (toggle `enable_nat_gateway` `count` pattern) + SGs `sg_app`/`sg_db`                                            | `map_public_ip_on_launch=true` public, `false` private; `private_subnet_ids` + `nat_gateway_id` outputs (Fase 7.3)                                                                                                                                             |
| `database` (`modules/database/main.tf:54-128`)             | `aws_db_parameter_group postgres15` (`log_min_duration_statement 1000`), `aws_db_instance postgres:15 gp3`                                                                                                                                                    | `multi_az prod?true:false`, `backup_retention prod 7:1`, `storage_encrypted`, `deletion_protection = var.enable_deletion_protection` (`local.effective_deletion_protection` en `main.tf:54` coalesce prod guard Fase 7.2), `performance_insights 731 prod` |
| `secrets` (`modules/secrets/main.tf:23-122`)               | `aws_ssm_parameter /erp/.../db-url` (SecureString), IAM roles `ecs_task_execution`/`ecs_task`                                                                                                                                                                 | `ssm:GetParameters` scoped a ARN (Fase 8 fix `GetParameter` + `kms:Decrypt`)                                                                                                                                                                                   |
| `compute` (`modules/compute/main.tf:31-450`)               | ECR ×5 `lifecycle keep var.ecr_image_retention_count=5` (`main.tf:46`), ECS cluster+service, task def via `templatefile(templates/taskdef.json.tftpl)` (Fase 7.4), Cloud Map `erp.local` + ALB `aws_lb`+TG+listener (Fase 10.4 toggle) + autoscaling 1-4 (Fase 10.3) | `cpu 512/mem 1024`, `circuit_breaker rollback=true`, `vpc_id` + `enable_alb/autoscaling/redis/sqs` vars, `aws_appautoscaling_target` CPU 70% + mem 80%                                                                                                       |
| `sqs` (`sqs.tf:1`)                                         | `aws_sqs_queue ordenes` + `ordenes-dlq` redrive 5 (Fase 10.6 toggle `enable_sqs`)                                                                                                                                                                             | `visibility_timeout 30` + DLQ 14d                                                                                                                                                                                                                               |
| `cache` (`cache.tf:1`)                                     | `aws_elasticache_cluster redis` `cache.t3.micro` + SG `sg_redis 6379` + subnet group (Fase 10.5 toggle `enable_redis`)                                                                                                                                       | `engine redis7`, `num_cache_nodes 1`, private o public subnets según `enable_nat_gateway`                                                                                                                                                                     |

## Servicios Node (Fase 2-5 + 10 + 11)

- **Shared kernel:** `packages/shared/src/{logger,db,errors,validate,middleware,metrics,tracing,circuitBreaker,cache,queue}.js` — monorepo `npm workspaces` (`package.json:6`), servicios importan `require('@erp/shared')` (Fase 2+10).
- Cada servicio: `PORT` 3001/3002/3003 (+ gateway 3004 Fase 11.1), `GET /`, `GET /health` (SELECT 1), `GET /health/live` (sin DB) + `GET /health/ready` (DB), `GET /api/v1/*` paginado (`?page&limit&sort` + `X-Total-Count/Link`) + legacy `/api/*` (Fase 3) + `GET /productos/:id` + `PUT/DELETE` + `GET /ordenes/_circuit` stats (Fase 10) + `GET /ordenes/:id?include=producto` BFF (`ordenes.js:152` Fase 11.1) + `GET /bff/ordenes/:id` en `svc-gateway` (`gateway/src/index.js:55`).
- Validación `zod` (`packages/shared/src/validate.js:8`) + `helmet/cors/compression/request-id` (`middleware.js:11`) + `AppError` central (`errors.js:23`) — Fase 3.5-3.6. Fix falsy `stock ?? 0` + `Number(precio)` (Fase 3.4).
- **API Contract:** OpenAPI 3.1 `docs/openapi.yaml:1` (`/api/productos`, `/api/v1/productos`, `/health/live`, `PaginatedProductos`, `Error`) + `docs/api.md:1` ejemplos `curl` BFF `include` + `frontend/app.js:23` `X-Cache`/`X-Total-Count` (Fase 3+11, ADR-006).
- **Data:** `schema_migrations` + `pg_advisory_lock 727727727` + `BEGIN/COMMIT` por archivo (`migrations/run.js:14-48`), triggers `updated_at` (002/004) + `stock invariant` (`005_stock_invariant.sql:6`) + `pg_trgm GIN` (`006_trigram_search.sql:5`) — Fase 5 + stock TX `BEGIN … FOR UPDATE` (`stock.js:42` Fase 10.2).
- **Scale:** `ordenes.js:23` HTTP `PRODUCTOS_URL` + `CircuitBreaker` fallback DB (10.1) + `queue.js:30` `publishOrdenCreada` SQS best-effort (10.6); `productos.js:15` `cache` Redis/memory `X-Cache` + invalidación `del productos:list:*` (10.5); `stock.js:42` validación stock insuficiente → `409 STOCK_CONFLICT`.
- **Frontend/BFF:** `frontend/index.html` + `app.js` static dashboard `http://localhost:8080` (`--profile frontend`) consume `GET /api/v1/{productos,ordenes,stock}` + `GET /ordenes/:id?include=producto` + `GET /bff/ordenes/:id` + `X-Request-Id` + `409` handling; `nginx.conf:102` + `nginx.local.conf:88` BFF location `gateway:3004` profile `gateway`.

## CI/CD (Fase 6 + 7)

- **Concurrency:** `pipeline.yml:38-40` `group: workflow-ref` + `cancel-in-progress: true` (Fase 6.1) + `teardown.yml:15` `concurrency: teardown-ref` (Fase 7.8).
- **Changes:** `pipeline.yml:58-107` `dorny/paths-filter@v3` → `productos/ordenes/stock/nginx/migrations/any_service` (Fase 6.7).
- **Lint:** `pipeline.yml:114-148` matrix + `eslint --cache` + `actions/cache .eslintcache` + summary (Fase 6.5).
- **Format:** `pipeline.yml:153-176` `prettier --check` (Fase 6.5).
- **Sec:** `pipeline.yml:182-235` `gitleaks/gitleaks-action@v2` + `aquasecurity/trivy-action fs` SARIF → code scanning (Fase 6.3).
- **Test:** `pipeline.yml:242-304` matrix `postgres:15`, `jest --coverage`, `upload-artifact coverage-*`, summary + `needs: [lint,format]` (Fase 6.6).
- **e2e:** `pipeline.yml:310-339` `docker compose up --build --wait` + `scripts/e2e.sh` (Fase 4.8).
- **Terraform PR:** `pipeline.yml:346-460` `fmt -check` → `init -backend=false` → `validate` → `tflint --init/--recursive` (`terraform/.tflint.hcl:1` `plugin aws 0.38.0`) → `checkov` SARIF → `init -reconfigure -backend-config=environments/backend-dev.hcl` → `plan -var-file=environments/dev.tfvars` OIDC → `sticky-pull-request-comment` + summary (Fase 6.4+7.1).
- **Build:** `pipeline.yml:467-613` `if: push main && any_service` → `docker/setup-buildx-action@v3` + `docker/build-push-action@v6` per-service `if: productos==true` con `cache-from/to: type=gha,mode=max` → ECR `:sha-<short>` + `:latest` (Fase 6.2 + 6.7).
- **Trivy image:** `pipeline.yml:619-672` matrix post-build `trivy image CRITICAL,HIGH` SARIF (soft-fail) (Fase 6.3).
- **Deploy:** `pipeline.yml:679-711` `scripts/deploy.sh:1` hardened lock+digest+rollback detect (`flock`, `ecr describe-images`, `register`, `wait services-stable`, rollback check) solo si `build` OK (Fase 7.7).
- **Teardown:** `teardown.yml:1-60` `schedule 23 UTC` + `workflow_dispatch` `confirm=destroy` + `environment=destroy` + prod guard `if: environment != prod` + `init -backend-config=environments/backend-*.hcl` + `destroy -var-file=environments/*.tfvars` (Fase 7.8).

## Observabilidad (Fase 9) + Scale metrics (Fase 10)

- `logger.js:14` JSON `timestamp/level/service/message/requestId` via `AsyncLocalStorage` (`logger.js:14` + `middleware.js:12` `enterWith`) → CloudWatch `/ecs/*` `retention 7d dev / 90d prod` (`compute/main.tf:110`).
- `observability.tf:34-150` metric filters `ServiceErrorCount` + `HttpLatency` (`$.ms`) + `Http5xxCount` (`$.status >=500`) → alarms `>10/5m` `p95>500ms` `5xx>10/5m` `DBConnections>80` (`AWS/RDS`) → SNS `alert_email`.
- `dashboard.tf:10` 6 widgets CPU/Mem/Error/Latency p95/5xx/DB conns + log table `filter level=error` → `erp-pipeline-{env}-overview`.
- `metrics.js:20` `prom-client` `http_request_duration_ms` histogram + `http_requests_total` + `http_active_requests` + EMF `HttpLatency` → `GET /metrics` (`services/*/src/index.js:14` + `nginx.conf:45`) + `X-Cache HIT/MISS` + `circuitBreaker` stats `GET /ordenes/_circuit`.
- `tracing.js:20` OTel `NodeSDK` `auto-instrumentations` `OTLPTraceExporter` `OTEL_ENABLED` + `TRACE_SAMPLE_RATIO 0.1` → X-Ray/Jaeger `http://localhost:4318/v1/traces` (`services/*/src/index.js:3` `initTracing`).
- `health.js:60` `/health/details` `pool {totalCount,idleCount,waitingCount}` + `uptime` + `memory` + `version` + `requestId` + ALB TG health `/health`.

## Seguridad (Fase 8)

- OIDC GitHub→AWS (`cicd.tf:16-65`, `ADR-002`) — `prod` solo `main` (`cicd.tf:56` Fase 8.5), thumbprint `data.tls_certificate` auto + rotation doc `docs/security/rotation.md:1`.
- SSM `SecureString` (`secrets/main.tf:23`) + `GetParameter/GetParameters` + `kms:Decrypt ViaService ssm` (`secrets/main.tf:73` Fase 8.1) + rotation manual `ssm put-parameter` + `taint random_password` (`docs/security/rotation.md:40`).
- `nginx.conf:14-40` `limit_req_zone 30r/s burst 60 429` + `server_tokens off` + headers `X-Content-Type-Options/HSTS/CSP/Permissions-Policy` (`nginx.conf:36` Fase 8.4) + `client_max_body_size 1m` + `proxy_hide_header`.
- `packages/shared/src/db.js:18` + `migrations/run.js:15` RDS TLS `rejectUnauthorized:true` en prod con CA `certs/rds-ca-bundle.pem` `/app/certs` (`Dockerfile:25` Fase 8.2) + `trust proxy 1` + `express-rate-limit 100/min` (`middleware.js:20` + `index.js:14` Fase 8.3).
- SGs (`networking/main.tf:114-181`) RDS solo `sg_app→5432`, `enable_nat_gateway=false` FinOps vs `ADR-003` WAF toggle cuando `enable_alb=true` (Fase 8.8).
- Supply chain: `gitleaks` + `trivy fs/image` + `npm audit --omit=dev high` + `snyk` (`pipeline.yml:180` Fase 8.7) + `checkov/tflint` 0 high.

## Convenciones

- **Node 20** (`.nvmrc:1`, `.tool-versions:1`), **LF** (`.editorconfig:1`), **Prettier** (`.prettierrc:1`), **ESLint** (`eslint:recommended` + `import/recommended` en `.eslintrc.js:8`).
- Commits `tipo(scope): msg`, PRs 1 scope, dependencias via `dependabot.yml` + `renovate.json`.

## Escalabilidad & Resiliencia (Fase 10)

- **ALB:** `aws_lb` + `aws_lb_target_group` `ip:80 /health` + `aws_lb_listener 80/443` (`compute/main.tf:320`) toggle `enable_alb=false→true` (~$16/mes) + SG `sg_alb`. Dev FinOps sin ALB (nginx sidecar), prod `enable_nat_gateway=true` + `enable_alb=true` + ACM.
- **Autoscaling:** `aws_appautoscaling_target` `1-4` `policy cpu 70%` + `memory 80%` (`compute/main.tf:296`) toggle `enable_autoscaling` — `desired_count = min` + `ignore_changes` para no driftear.
- **Cache:** `cache.js:1` `ioredis` `REDIS_URL` o memory LRU `30s` + `productos.js:15` `X-Cache` + `ElastiCache redis` `cache.t3.micro` (`cache.tf:1` `enable_redis`).
- **Queue:** `queue.js:1` `@aws-sdk/client-sqs` `SQS_QUEUE_URL` + `sqs.tf:1` `ordenes` + DLQ (10.6) + `ordenes.js:140` `publishOrdenCreada` async best-effort.
- **HTTP decoupling:** `ordenes.js:23` `PRODUCTOS_URL=http://productos.erp.local:3001` (Cloud Map) o `http://productos:3001` compose + `circuitBreaker.js:1` `CLOSED→OPEN→HALF_OPEN` + fallback DB.
- **Stock TX:** `stock.js:42` `BEGIN; SELECT FOR UPDATE; INSERT; COMMIT` + `409` si insufficient + publish `stock.actualizado`.
- **Resiliencia verif:** `scripts/chaos.sh:1` kill/latency/cache/409 + `scripts/k6/resilience.js:1` 50 rps p95<300ms.
- Ver `docs/adr/ADR-004-scaling-strategy.md:1` coste completo prod ~$64 vs dev $0 FinOps.

## Producto & Portfolio Polish (Fase 11)

- **BFF:** `services/ordenes/src/routes/ordenes.js:152` `GET /:id?include=producto` (`_bff: "orden+producto aggregated"` + fallback DB) + `services/gateway/src/index.js:55` `GET /bff/ordenes/:id` dual `CircuitBreaker` agregación `orden` + `producto` + `nginx.conf:102` `location /api/v1/bff/ordenes` `proxy_pass gateway:3004` (local) / `127.0.0.1:3004` (ECS) profile `gateway`.
- **Frontend:** `frontend/{index.html,app.js,styles.css,Dockerfile}` static dashboard (Fase 11.2) `http://localhost:8080` (`--profile frontend`) consume `GET /api/v1/...` + `X-Cache` + `BFF include` + `409` handling + `X-Request-Id` + `frontend/README.md:1`.
- **Demo:** `docs/demo.md:1` loom + `docs/screenshots/demo.gif` + refresh `aws_console.png/cloudwatch.png/github_actions.png/json_*.png` + `docs/screenshots` tabla (Fase 11.3).
- **Badges:** `README.md:3` coverage `>80%` + OpenAPI 3.1 + trivy + prettier + release + demo (`pipeline.yml` `coverage` Fase 4.7 + `trivy` Fase 6.3).
- **ADRs:** `docs/adr/ADR-005-monorepo-shared-kernel.md:1` (Fase 2) + `ADR-006-openapi-versioning.md:1` (Fase 3) + `ADR-README` index (Fase 11.5).
- **Release:** `package.json:12` `release` `semantic-release` + `CHANGELOG.md:1` + `.releaserc.json:1` (`commit-analyzer/changelog/github/git`) + `.github/workflows/release.yml:1` push `main` tag `v*` (Fase 11.6).
- **Interview:** `docs/interview.md:1` 17 Q&A rollback/FinOps/decoupling/cache/BFF/WAF/observabilidad (Fase 11.7) — 30m prep senior.
- Ver `docs/interview.md:7` “¿Por qué monorepo?” + `docs/demo.md:70` comandos demo.

## Roadmap

Ver `PLAN_ELEVACION_11_FASES.md` (gitignored) — 11 fases de scaffold → production-grade. **Fases 1-11 completadas:** higiene (1) → compose+monorepo (2) → hardening API (3) → testing (4) → datos enterprise (5) → CI (6) → infra multi-env (7) → sec profunda (8) → observabilidad (9) → scale & resiliencia (10) → producto & portfolio polish (11) *shippable senior*.

## Runbooks & Portfolio (Fase 7.9 + 8.6 + 9.8 + 10.8 + 11)

- `docs/runbooks/deploy.md:1` — deploy normal + `deploy.sh` verificación digest + lock
- `docs/runbooks/rollback.md:1` — rollback automático circuit breaker vs manual `IMAGE_TAG=sha-prev`
- `docs/runbooks/drift.md:1` — drift `plan -var-file=environments/*.tfvars` + `ignore_changes` de `task_definition`
- `docs/security/rotation.md:1` — OIDC thumbprint + SSM/RDS password rotation (Fase 8.6)
- `docs/adr/ADR-003-waf.md:1` — WAF toggle cuando `enable_alb=true` (Fase 8.8)
- `docs/adr/ADR-004-scaling-strategy.md:1` — FinOps $0 → prod toggle ALB/autoscaling/redis/sqs (Fase 10.8)
- `docs/observability.md:1` — logs Insights + metrics/prom + dashboard + tracing + health/details (Fase 9.8)
- `docs/runbooks/alert.md:1` — triage <5m dashboard→logs→health→traces→rollback (Fase 9.8)
- `scripts/chaos.sh:1` + `scripts/k6/resilience.js:1` — resilience kill/cache/circuit 50 rps (Fase 10.7)
- `docs/demo.md:1` — 2m demo loom + `frontend/index.html` `http://localhost:8080` + `GET /ordenes/:id?include=producto` BFF (Fase 11.3)
- `docs/interview.md:1` — 17 Q&A rollback/FinOps/BFF/cache/WAF (Fase 11.7)
- `docs/adr/ADR-005-monorepo-shared-kernel.md:1` + `ADR-006-openapi-versioning.md:1` — monorepo + OpenAPI (Fase 11.5)
- `.releaserc.json:1` + `CHANGELOG.md:1` + `.github/workflows/release.yml:1` — semantic-release tags `v*` (Fase 11.6)
