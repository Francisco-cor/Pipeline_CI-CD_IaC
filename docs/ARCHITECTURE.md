# Architecture — ERP Pipeline

> Mapa rápido del repo. Para decisiones con trade-off ver `docs/adr/`.

## Stack (resumen)

- **Runtime:** Node 20 + Express 4 + `pg` 8, PostgreSQL 15 en RDS `db.t3.micro`.
- **Infra:** AWS ECS Fargate (task 0.5 vCPU/1GB), ECR, RDS, SSM Parameter Store, CloudWatch, SNS.
- **IaC:** Terraform 1.9+ modular (`terraform/modules/*`), backend S3+DynamoDB (`terraform/backend.tf:1-38`), `terraform/.tflint.hcl:1` + `checkov` (Fase 6.4).
- **CI/CD:** GitHub Actions OIDC (`terraform/cicd.tf:17-65`, `ADR-002`), `concurrency` + `paths-filter` + `lint --cache` + `gitleaks/trivy` + `tflint/checkov` + `buildx gha cache` + `coverage` (`pipeline.yml:18-711`) — Fase 6 (<6m PR).
- **Proxy:** NGINX sidecar (`nginx/nginx.conf:1-96`) en misma task ECS (awsvpc, `localhost`).

## Layout

```
.
├── services/{productos,ordenes,stock}/src/
│   ├── index.js        # express app + graceful SIGTERM
│   ├── db.js           # pg Pool (max 3, ssl auto)
│   ├── logger.js       # JSON stdout → CloudWatch
│   ├── routes/{health,*.js}
│   └── __tests__/health.test.js
├── migrations/{run.js, sql/001_*.sql ..}
├── nginx/{nginx.conf, Dockerfile}
├── terraform/
│   ├── main.tf               # compone networking → database → secrets → compute
│   ├── modules/{networking,database,secrets,compute}
│   ├── cicd.tf               # OIDC provider + role (github_actions)
│   ├── observability.tf      # metric filter + alarm
│   └── backend.tf            # S3 remote state
├── scripts/{build.sh,deploy.sh,bootstrap-backend.{sh,ps1}}
└── docs/{adr/,ARCHITECTURE.md}
```

## Flujo de request

```
Internet → ECS task public IP:80 → NGINX (rate 30r/s) → svc-productos:3001 | svc-ordenes:3002 | svc-stock:3003
                                          → /health 200 (nginx)
                                          → /api/{productos,ordenes,stock}/health → upstream health
                                          → /api/{productos,ordenes,stock}(/*) → proxy_pass http://X/X$1
Migrations (init, essential:false, SUCCESS) bloquea resto hasta exit 0
RDS (sg_db:5432 solo desde sg_app) ← servicios; SSM → DATABASE_URL inyectado al inicio
```

Ver `README.md:29-76` (mermaid) y `ADR-001` para coste $0 (public subnets sin NAT).

## Módulos Terraform

| Módulo | Crea | Clave |
|---|---|---|
| `networking` (`modules/networking/main.tf:27-181`) | VPC `10.0.0.0/16`, 2 public subnets, IGW, SGs `sg_app`/`sg_db` | `map_public_ip_on_launch=true`, SG como perímetro |
| `database` (`modules/database/main.tf:54-98`) | `aws_db_parameter_group postgres15` (`log_min_duration_statement 1000`), `aws_db_instance postgres:15 gp3` | `multi_az prod?true:false`, `backup_retention prod 7:1`, `storage_encrypted`, `deletion_protection prod`, `performance_insights 731 prod` (Fase 5.8) |
| `secrets` (`modules/secrets/main.tf:23-122`) | `aws_ssm_parameter /erp/.../db-url` (SecureString), IAM roles `ecs_task_execution`/`ecs_task` | `secretsmanager:GetSecretValue` scoped a ARN |
| `compute` (`modules/compute/main.tf:31-428`) | ECR ×5, ECS cluster+service, task def 5 contenedores | `cpu 512/mem 1024`, `circuit_breaker rollback=true`, ECR lifecycle `keep 1` (a subir a 5 en Fase 7) |

## Servicios Node (Fase 2-5 completadas)

- **Shared kernel:** `packages/shared/src/{logger,db,errors,validate,middleware}.js` — monorepo `npm workspaces` (`package.json:6`), servicios importan `require('@erp/shared')` (Fase 2).
- Cada servicio: `PORT` 3001/3002/3003, `GET /`, `GET /health` (SELECT 1), `GET /health/live` (sin DB) + `GET /health/ready` (DB), `GET /api/v1/*` paginado (`?page&limit&sort` + `X-Total-Count/Link`) + legacy `/api/*` (Fase 3).
- Validación `zod` (`packages/shared/src/validate.js:8`) + `helmet/cors/compression/request-id` (`middleware.js:11`) + `AppError` central (`errors.js:23`) — Fase 3.5-3.6. Fix falsy `stock ?? 0` + `Number(precio)` (Fase 3.4).
- **Data:** `schema_migrations` + `pg_advisory_lock 727727727` + `BEGIN/COMMIT` por archivo (`migrations/run.js:14-48`), triggers `updated_at` (002/004) + `stock invariant` (`005_stock_invariant.sql:6`) + `pg_trgm GIN` (`006_trigram_search.sql:5`) — Fase 5.

## CI/CD (Fase 6)

- **Concurrency:** `pipeline.yml:38-40` `group: workflow-ref` + `cancel-in-progress: true` (Fase 6.1).
- **Changes:** `pipeline.yml:58-107` `dorny/paths-filter@v3` → `productos/ordenes/stock/nginx/migrations/any_service` (Fase 6.7).
- **Lint:** `pipeline.yml:114-148` matrix + `eslint --cache` + `actions/cache .eslintcache` + summary (Fase 6.5).
- **Format:** `pipeline.yml:153-176` `prettier --check` (Fase 6.5).
- **Sec:** `pipeline.yml:182-235` `gitleaks/gitleaks-action@v2` + `aquasecurity/trivy-action fs` SARIF → code scanning (Fase 6.3).
- **Test:** `pipeline.yml:242-304` matrix `postgres:15`, `jest --coverage`, `upload-artifact coverage-*`, summary + `needs: [lint,format]` (Fase 6.6).
- **e2e:** `pipeline.yml:310-339` `docker compose up --build --wait` + `scripts/e2e.sh` (Fase 4.8).
- **Terraform PR:** `pipeline.yml:346-460` `fmt -check` → `init -backend=false` → `validate` → `tflint --init/--recursive` (`terraform/.tflint.hcl:1` `plugin aws 0.38.0`) → `checkov` SARIF → `init` OIDC → `plan` → `sticky-pull-request-comment` + summary (Fase 6.4 + 6.8).
- **Build:** `pipeline.yml:467-613` `if: push main && any_service` → `docker/setup-buildx-action@v3` + `docker/build-push-action@v6` per-service `if: productos==true` con `cache-from/to: type=gha,mode=max` → ECR `:sha-<short>` + `:latest` (Fase 6.2 + 6.7).
- **Trivy image:** `pipeline.yml:619-672` matrix post-build `trivy image CRITICAL,HIGH` SARIF (soft-fail) (Fase 6.3).
- **Deploy:** `pipeline.yml:679-711` `scripts/deploy.sh` (python JSON swap + `aws ecs wait services-stable`) solo si `build` OK.

## Observabilidad

- `logger.js` → stdout JSON `{timestamp,level,service,message}`; CloudWatch lo captura (`compute/main.tf:110-117`).
- `observability.tf:34-63` metric filter `{$.level="error"}` → `ServiceErrorCount` → alarm `>10/5m` → SNS `alert_email`.
- Fase 9 añade dashboard, p95, traces.

## Seguridad

- OIDC GitHub→AWS (`cicd.tf:16-65`, `ADR-002`), sin keys.
- SSM `SecureString` (`secrets/main.tf:23`), IAM `PassRole` scoped.
- `nginx.conf:14-20` `limit_req_zone 30r/s`, `db.js:7-8` SSL auto si `amazonaws.com`, SGs (`networking/main.tf:114-181`) — RDS solo `sg_app→5432`.

## Convenciones

- **Node 20** (`.nvmrc:1`, `.tool-versions:1`), **LF** (`.editorconfig:1`), **Prettier** (`.prettierrc:1`), **ESLint** (`eslint:recommended` + `import/recommended` en `.eslintrc.js:8`).
- Commits `tipo(scope): msg`, PRs 1 scope, dependencias via `dependabot.yml` + `renovate.json`.

## Roadmap

Ver `PLAN_ELEVACION_11_FASES.md` (gitignored) — 11 fases de scaffold → production-grade. **Fases 1-6 completadas:** higiene (1) → compose+monorepo (2) → hardening API (3) → testing (4) → datos enterprise (5) → CI (6). Siguiente: Fase 7 infra multi-env + Fase 8 sec profunda.

