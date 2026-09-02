# Changelog — ERP Pipeline

> Formato `Keep a Changelog` + `Conventional Commits`. Generado con `semantic-release` + `conventional-changelog` (`npm run changelog`).
> Tags `v*` en `git tag --list` — ver `.releaserc.json:1`.

Todos los cambios notables. `Unreleased` es `main` post-último tag.

---

## [1.11.0] — 2026-09-02 — Fase 11 polish (portfolio)

### Added

- **BFF** `GET /api/v1/ordenes/:id?include=producto` aggregation via `CircuitBreaker` + `GET /api/v1/bff/ordenes/:id` gateway `services/gateway` (`services/ordenes/src/routes/ordenes.js:152`, `services/gateway/src/index.js:1`, `nginx.conf:102`, `nginx.local.conf:88`) — Fase 11.1
- **Frontend** static dashboard `frontend/{index.html,app.js,styles.css,Dockerfile}` consume `GET /api/v1/...` con `X-Cache`, `X-Request-Id`, BFF, 409 handling (`frontend/README.md:1`) — Fase 11.2 `docker compose --profile frontend up` → `http://localhost:8080` + `gateway` profile `3004`
- **Demo** `docs/demo.md:1` loom + `docs/screenshots/demo.gif` + refresh tabla screenshots (Fase 11.3)
- **Badges** `README.md:3` coverage 80% + OpenAPI 3.1 + trivy + prettier + release + demo
- **ADRs** `docs/adr/ADR-005-monorepo-shared-kernel.md:1` + `ADR-006-openapi-versioning.md:1` (Fases 2/3) + `ADR-README` index
- **Release** `.releaserc.json:1` `semantic-release` `commit-analyzer/release-notes/changelog/npm/github/git` + `CHANGELOG.md:1` + `package.json:12` `release/changelog` scripts + `.github/workflows/release.yml` + tags `v1.11.0`
- **Interview** `docs/interview.md:1` 17 Q&A rollback, FinOps, decoupling, cache, BFF, WAF, observability (Fase 11.7)

### Changed

- `README.md:3` badges + `README.md:190` Demo & Portfolio section Fase 11 links
- `docs/ARCHITECTURE.md:42` layout frontend/gateway + roadmap 1-11 + runbooks Fase 11
- `nginx/nginx.conf:22` + `nginx.local.conf:22` upstream `gateway` + BFF location
- `docker-compose.yml:149` gateway/frontend profiles
- `package.json:12` devDeps `semantic-release` `conventional-changelog-cli`

---

## [1.10.0] — 2026-09-02 — Fase 10 scale & resilience (FinOps toggle)

### Added

- Circuit breaker `packages/shared/src/circuitBreaker.js:1` + cache Redis/memory `cache.js:1` + queue SQS `queue.js:1`
- Decoupling `ordenes → productos` HTTP `PRODUCTOS_URL` + fallback DB (`ordenes.js:23`), `GET /productos/:id`, `PUT/DELETE`, `GET /ordenes/_circuit`
- Stock TX `BEGIN; SELECT FOR UPDATE; INSERT; COMMIT` + `409 STOCK_CONFLICT` (`stock.js:42`), `POST /productos` `GET /productos` `X-Cache`
- ALB `aws_lb` + TG `ip:80 /health` + listeners 80/443 (`compute/main.tf:320`) toggle `enable_alb`
- Autoscaling `aws_appautoscaling_target 1-4` CPU 70% + memory 80% (`compute/main.tf:296`) toggle `enable_autoscaling`
- Redis `redis:7-alpine` compose + ElastiCache `cache.t3.micro` (`cache.tf:1`) toggle `enable_redis`, SQS `ordenes` + DLQ (`sqs.tf:1`) toggle `enable_sqs`
- `scripts/chaos.sh:1` + `scripts/k6/resilience.js:1` 50 rps p95<300ms

### Changed

- `terraform/variables.tf:80` toggles `enable_alb/autoscaling/redis/sqs`, `environments/*.tfvars`, `outputs.tf`, `cache.tf/sqs.tf`, `taskdef.json.tftpl` `REDIS_URL/SQS_QUEUE_URL/PRODUCTOS_URL`
- `docker-compose.yml:42` redis healthcheck + envs `REDIS_URL/CACHE_TTL/PRODUCTOS_URL`

Docs: `README.md:160` Scale, `ARCHITECTURE.md:54` módulos Fase 10, `ADR-004-scaling-strategy.md:1`

---

## [1.9.0] — 2026-09-02 — Fase 9 observabilidad

- Logs `AsyncLocalStorage` `requestId` (`logger.js:14` + `middleware.js:12`), retention `7d dev / 90d prod` (`compute/main.tf:110`)
- Metrics `prom-client` histogram + `http_requests_total` + `GET /metrics` (`metrics.js:20`, `nginx.conf:45`)
- Dashboard `dashboard.tf:10` 6 widgets + `observability.tf:49` 4 alarmas `ServiceErrorCount/p95/5xx/DBConnections`
- Tracing OTel `tracing.js:20` `OTEL_ENABLED` + `health/details` pool stats (`health.js:60`)
- Docs `docs/observability.md:1` + `runbooks/alert.md:1`

Docs: `README.md:145` Monitoring, `ARCHITECTURE.md:85` Observabilidad, roadmap 1-9

---

## [1.8.0] — 2026-09-02 — Fase 8 seguridad

- SSM `GetParameter/GetParameters + kms:Decrypt ViaService`, RDS CA bundle `certs/rds-ca-bundle.pem` `/app/certs` `rejectUnauthorized:true` prod (`db.js:18`)
- `helmet/cors/compression/rate-limit 100/min` + `trust proxy 1` (`middleware.js:20`), NGINX `limit_req_zone 30r/s burst 60 429` + headers `X-Content-Type-Options/HSTS` (`nginx.conf:36`)
- OIDC prod `refs/heads/main` strict (`cicd.tf:56`), `gitleaks/trivy` + `npm audit --omit=dev high` + `snyk` (`pipeline.yml:180`), WAF ADR-003

---

## [1.7.0] — 2026-09-01 — Fase 7 infra multi-env

- `environments/{dev,staging,prod}.tfvars + backend.hcl` per env, `enable_nat_gateway` `count` private subnets + NAT toggle, `taskdef.json.tftpl` templatefile, ECR `keep 5`, Cloud Map `erp.local` service discovery, `deploy.sh` hardened lock+digest+wait, teardown prod guard

---

## [1.6.0] — 2026-09-01 — Fase 6 CI

- `concurrency` cancel, `buildx gha cache`, `gitleaks/trivy fs`, `terraform fmt/validate/tflint/checkov`, `eslint --cache`, `dorny/paths-filter`, `jest --coverage` artifacts, `build` `cache-from/to gha`

---

## [1.5.0] — 2026-09-01 — Fase 5 datos

- `schema_migrations` + advisory lock + transactional per-file, triggers `updated_at`, stock invariant `005_stock_invariant.sql`, `pg_trgm GIN`, `rds parameter group`, backup 7d prod

---

## [1.4.0] — 2026-09-01 — Fase 4 testing

- `jest --forceExit --coverage` + `test-helpers` + `productos/ordenes/stock` CRUD + pagination + validation + contract + `e2e.sh` + `k6/smoke.js` coverage 80% threshold

---

## [1.3.0] — 2026-09-01 — Fase 3 hardening API

- OpenAPI 3.1 `docs/openapi.yaml`, `/api/v1` versioned + legacy `/api`, `zod` `validateRequest`, `stock ?? 0` fix, `helmet/cors/compression/request-id`, `AppError`, pagination `?page&limit&sort` + `Link`, health `live/ready`

---

## [1.2.0] — 2026-05-20 — Fase 2 DX & monorepo

- `docker-compose.yml` + `compose.override.yml` hot-reload + `npm workspaces` `packages/shared` `{logger,db,errors,validate}` + `Makefile` + `.dockerignore`

---

## [1.1.0] — 2026-05-20 — Fase 1 higiene

- `.editorconfig/.nvmrc/.tool-versions/.prettierrc`, `eslint import/order`, `.gitattributes`, `CODEOWNERS`, `dependabot/renovate`, `ARCHITECTURE.md`, `bootstrap-backend.sh` idempotencia

---

## [0.1.0] — 2026-03-20 — Scaffold

- VPC, RDS `db.t3.micro`, ECS sidecar nginx + 3 Node services, SSM secrets, OIDC, pipeline `lint→test→build→deploy`

---

## Unreleased

- Ver `git log --oneline` para commits post `v1.11.0`
- Release next: `npm run release` (semantic-release) o `npm run changelog` (preview)

[1.11.0]: https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/releases/tag/v1.11.0
[1.10.0]: https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/releases/tag/v1.10.0
[1.9.0]: https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/releases/tag/v1.9.0
[1.8.0]: https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/releases/tag/v1.8.0
[1.7.0]: https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/releases/tag/v1.7.0
