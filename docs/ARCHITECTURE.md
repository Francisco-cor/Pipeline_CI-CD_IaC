# Architecture — ERP Pipeline

> Mapa rápido del repo. Para decisiones con trade-off ver `docs/adr/`.

## Stack (resumen)

- **Runtime:** Node 20 + Express 4 + `pg` 8, PostgreSQL 15 en RDS `db.t3.micro`.
- **Infra:** AWS ECS Fargate (task 0.5 vCPU/1GB), ECR, RDS, SSM Parameter Store, CloudWatch, SNS.
- **IaC:** Terraform 1.9+ modular (`terraform/modules/*`), backend S3+DynamoDB (`terraform/backend.tf:1-38`).
- **CI/CD:** GitHub Actions OIDC (`terraform/cicd.tf:17-65`, `ADR-002`), `lint → test → build → deploy` (`pipeline.yml:18-235`).
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
| `database` (`modules/database/main.tf:27-99`) | `random_password`, `aws_db_subnet_group`, `aws_db_instance postgres:15` | `multi_az=false`, `backup_retention=0` (dev), `performance_insights=true` |
| `secrets` (`modules/secrets/main.tf:23-122`) | `aws_ssm_parameter /erp/.../db-url` (SecureString), IAM roles `ecs_task_execution`/`ecs_task` | `secretsmanager:GetSecretValue` scoped a ARN |
| `compute` (`modules/compute/main.tf:31-428`) | ECR ×5, ECS cluster+service, task def 5 contenedores | `cpu 512/mem 1024`, `circuit_breaker rollback=true`, ECR lifecycle `keep 1` (a subir a 5 en Fase 7) |

## Servicios Node

- Duplicados hoy: `db.js:1-20`, `logger.js:1-23`, `health.js` (≈ Fase 2 unifica en `packages/shared`).
- Cada servicio: `PORT` 3001/3002/3003, `GET /`, `GET /health` (SELECT 1), `GET /productos|ordenes|stock`, `POST /`.
- Validación mínima manual (Fase 3 → zod), errores `500 {error: message}` (Fase 3 → `{code,message,details}`), paginación `LIMIT 50` (Fase 3 → `?page&limit`).

## CI/CD

- `pipeline.yml:39-59` lint matrix por servicio, cache npm por `package-lock.json`.
- `pipeline.yml:76-89` test con `postgres:15` service container, migraciones previas `migrations/run.js`.
- `pipeline.yml:122-157` `terraform fmt -check + plan` solo en PR (requiere OIDC `pull_request` en `cicd.tf:58-62`).
- `pipeline.yml:165-201` build → ECR `:sha-<short>` + `:latest`, `pipeline.yml:208-235` deploy vía `scripts/deploy.sh` (python JSON swap + `aws ecs wait services-stable`).

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

Ver `PLAN_ELEVACION_11_FASES.md` (gitignored) — 11 fases de scaffold → production-grade. Fase 1 (esta) = higiene; Fase 2 = compose+monorepo; etc.

