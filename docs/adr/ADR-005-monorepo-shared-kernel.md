# ADR-005: Monorepo `npm workspaces` + `packages/shared` kernel

## Status

Accepted (Fase 2)

## Date

2026-09-02

## Context

Scaffold inicial tenía **duplicación masiva** (`db.js`, `logger.js`, `health.js`, `index.js` copiados 3× en `services/{productos,ordenes,stock}` >90% idéntico). Sin workspace, cada servicio tenía su `db.js` con `ssl: { rejectUnauthorized:false }` y su `logger.js` JSON, pero con bugs divergentes (`stock || 0` vs `stock ?? 0`, `log_min_duration_statement` solo en productos). Onboarding roto: README decía `docker compose up` pero no había `docker-compose.yml` (Fase 2 gap P0).

Opciones: mantener duplicados, extraer a paquete npm publicado, monorepo workspaces.

## Decision

**Monorepo `npm workspaces`** (`package.json:6` `workspaces: ["services/*","migrations","packages/*"]`) + **`packages/shared` kernel** (`packages/shared/src/{logger,db,errors,validate,middleware,pagination,metrics,tracing,circuitBreaker,cache,queue}.js`).

- `services/*/src/index.js:3` importa `require('@erp/shared')` (`@erp/shared` → `file:../../packages/shared` en `services/*/package.json:15`).
- `db.js:18` unifica SSL RDS auto-detección `amazonaws.com` + `rejectUnauthorized:true` prod con CA `certs/rds-ca-bundle.pem` (Fase 8.2) + `max 3` por env `DB_POOL_MAX`.
- `logger.js:14` JSON `requestId` via `AsyncLocalStorage` + `middleware.js:12` `enterWith` (Fase 9.1) → CloudWatch `/ecs/*`.
- `validate.js:8` `zod` schemas + `errors.js:23` `AppError` central + `pagination.js` `parsePagination/setPaginationHeaders` (Fase 3).
- `metrics.js:20` `prom-client` + EMF `HttpLatency`, `tracing.js:20` OTel `NodeSDK`, `circuitBreaker.js:1` Fase 10.1, `cache.js:1` Fase 10.5, `queue.js:1` Fase 10.6.
- `docker-compose.yml:1` + `docker-compose.override.yml:1` montan `packages/shared/src` como volumen para hot-reload; `make dev` usa `nodemon` sin rebuild (Fase 2.6 `Makefile:33`).
- `packages/test-helpers` con factories `faker` (Fase 4.2) también workspace.

Build: `npm ci` en root instala `node_modules/@erp/shared` symlink + `services/*` deps; `npm run lint --workspaces` + `npm test --workspaces` (Fase 6.5 `pipeline.yml:114`).

## Consequences

### Positive

- **-60% duplicación** (medir `jscpd`) — bug `stock ?? 0` se fija una vez en `validate.js` + `productos.js:49`, no 3×.
- **DX impecable:** `git clone && npm install && docker compose up --build` <180s con seed + health verdes (Fase 2 métrica); `docker-compose.override.yml` hot-reload sin rebuild.
- **Cambios atómicos:** actualizar `helmet` o `pg Pool max` en un solo lugar + tests verdes en 3 servicios (CI matrix `pipeline.yml:242`).
- **Tracing/metrics/cache/queue** agregados una vez en shared (Fases 9-10) y consumidos por `servicios/*/src/index.js:14` sin copy-paste.

### Negative

- **Workspace coupling:** cambio breaking en `shared` rompe 3 servicios si no se versiona; mitigado con `npm run test --workspaces` + `coverageThreshold 80%` (`services/productos/package.json:44`).
- **Docker layer cache:** `COPY packages/shared/src` en `services/*/Dockerfile:11` invalida cache si shared cambia — aceptable, `buildx gha cache ~60% hit` (Fase 6.2).
- **No publish:** `@erp/shared` no se publica a npm (file: link) — si se necesita consumo externo, migrar a `npm publish` o `turborepo`.

### Trade-offs Accepted

> Aceptamos coupling monorepo vs multi-repo independiente porque el equipo es 1 dev portfolio y el valor está en `make verify` verde en máquina limpia, no en deploy independiente por servicio. Si escala a 10 equipos, migrar a `pnpm` + `changesets` + publish.

## Alternatives Considered

### 1. Mantener duplicados (rejected)

- Rápido al inicio, pero Fase 3-5 bugs requieren fix en 3 lugares → drift (`stock || 0` bug Fase 3.4 se repitió). `jscpd` 70% duplicación bloquea credibilidad senior.

### 2. Paquete npm publicado `@erp/shared` (rejected)

- Requiere versionado semver + CI publish + registry privado — overkill para portfolio 3 servicios internos. `file:` link es suficiente, compatible con `npm ci` sin registry.

### 3. Turborepo / Nx multi-package (rejected)

- Añade orquestación `turbo run lint` + cache remoto — beneficio marginal con 3 servicios, complejidad extra para entrevista. `npm workspaces` nativo es suficiente; Fase 11 podría migrar a `turbo` si se añade `frontend/` Next.js.

### 4. Lerna (rejected)

- Legacy, `npm workspaces` + `npm run --workspaces` cubre case sin extra tooling.

## References

- `package.json:6` workspaces + `packages/shared/package.json:1` + `services/productos/package.json:15` `@erp/shared` file
- `packages/shared/src/{logger,db,errors,validate,middleware}.js` Fase 2-3 + `circuitBreaker,cache,queue` Fase 10
- `docker-compose.yml:1` + `docker-compose.override.yml:12` hot-reload
- `Makefile:33` `make dev` + `pipeline.yml:114` lint/test matrix workspaces
- `docs/ARCHITECTURE.md:74` shared kernel
- `docs/interview.md:7` “¿Por qué monorepo?”
