# [1.13.0](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/compare/v1.12.0...v1.13.0) (2026-11-14)


### Bug Fixes

* **ci:** build migrations image from the repo root ([6fb326f](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/6fb326fcdaf88cf45aebb8385eb51a99cec7505b))
* **ci:** keep smoke and canary on public health endpoints ([205b567](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/205b567489cad13991c68b8e52055573ffe7cec2))
* **deps:** clear high/critical production CVEs ([682c99d](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/682c99d7ba6b2585b8c91be10cf68d50957c6935))
* **dx:** keep DB-backed shared test out of test-unit ([0552d3d](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/0552d3dbdfb72c2d97e7d97bc21aa95d918fa988))
* **ecs:** use loopback sidecar URLs and liveness healthchecks ([18dba48](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/18dba4839f999dba9f250f3c232ebc548fd07a2e))
* **governance:** align ruleset merge methods and make pre-commit portable ([2ee05f1](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/2ee05f1580d151931ccbbbc92c30525e82228500))
* **governance:** link bug reports to the private advisory channel ([a68e719](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/a68e7198a8da357b007299c255d1e4e1452a7f1d))
* **migrations:** checksum applied files and resolve the duplicate 007 ([83e9f3d](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/83e9f3d00d8f8bc284ef8c1c6666d5197d63bdf3))
* **orders:** reserve stock atomically and compute totals server-side ([13f2ca0](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/13f2ca0aaccced1ffd63968ce1b63b3cce0ce5ba))
* **productos:** keep stock changes in the movement ledger ([6212ab9](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/6212ab958faefe7040793c63c71077b43808be9f))
* **shared:** map database errors and bound validation/pagination ([9d23d0e](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/9d23d0e724098623445b2d3ea7d9fb4da3174e0d))
* **terraform:** keep the Redis AUTH token out of ECS variables ([2bc8877](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/2bc8877c9773bf56e1117386412aea2d90ab02e9))
* **test:** pin faker as a CommonJS dev dependency ([1699442](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/169944257a3b85449cd7485d48e0b2a7ee1a71da))


### Features

* **bootstrap:** protect OIDC identity and add per-env bootstrap backends ([d7f1b13](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/d7f1b130362230bedfb569422766720eccdb08ee))
* **canary:** probe public endpoints every 30 minutes ([5fcae66](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/5fcae661ed3e01423596b143e46ca606745ad04f))
* **ci:** validate migrations and promote through environments ([7186473](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/71864739551c3b25b9576a4789f9715aeba51828))
* **dr:** add restore runbook and drill script ([b06a7a7](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/b06a7a70730009aeee2a5c02b2c3269ef0043e00))
* **frontend:** complete accessibility, strict CSP and performance budget ([8e22efa](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/8e22efab683d24591baab2d397dd99e861794552))
* **frontend:** validate API origin and ship security headers ([33cde4c](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/33cde4ce64efa5fddc12ac4cef816ac23110592f))
* **governance:** add ownership, PR/issue templates and main ruleset ([a242c91](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/a242c9195312a131ca7088c3ace61140404da7ed))
* **infra:** enforce database, Redis and SQS encryption guards ([3f14482](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/3f144825fb7826d8d587e32d3d229c1f69b8ae2e))
* **observability:** document SLOs and extend the dashboard ([0174524](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/0174524a251ce0db2e502537e1ff473cffce797a))
* **release:** summarize the created tag and its image ([bbb812a](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/bbb812a161a84e21e83fc6af35d64a9244cf26f0))
* **runtime:** split liveness/readiness and coordinate shutdown ([18785b6](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/18785b6a9189801023607ff4a5008fef6b4768c5))
* **services:** enforce auth, audit and diagnostics at the service edge ([5fa2dc5](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/5fa2dc5a02ca9b27802dce9a7842f4035b2b8fb7))
* **shared:** add idempotency, health and lifecycle primitives ([4fdc0f3](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/4fdc0f33ac1a127507310d9a844d3c38b17651df))
* **shared:** add JWT auth, RBAC, audit log and diagnostics gates ([9ee4e02](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/9ee4e02ac4372bf1ff81c67684a819572cbad5ef))
* **stock:** make manual stock movements idempotent ([648c47b](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/648c47ba9d6833c01bd6cad176172ea07cdc8b99))
* **terraform:** add SLO alarms, budgets and cost tags ([d7ec1e8](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/d7ec1e834ca7b3dc35df3a580abe59073c1e6e81))

# [1.12.0](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/compare/v1.11.0...v1.12.0) (2026-09-22)


### Features

* **events:** add transactional SQS outbox and idempotent consumer ([f78cefc](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/f78cefcad962d01606ac5d90b12c30647c5f7681))
* harden pipeline and complete gateway delivery ([f693475](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/f6934758e7c82b7a602945d2260911d346bc662a))
* **network:** enforce private production subnets ([7390cae](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/7390caeca5db69c5e67597ca710d4d557fbee62c))
* **observability:** alert on SQS backlog and DLQ ([cfe64ec](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/cfe64ec7608f4fc3b1274cb835dae818cfc64349))
* **security:** harden production edge and encryption ([b88a940](https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/commit/b88a940520a48d04ae19d54aff6abe2bd0d5bed5))

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
