# ADR-006: OpenAPI 3.1 + versionado `/api/v1` + paginación + `AppError`

## Status

Accepted (Fase 3)

## Date

2026-09-02

## Context

Scaffold tenía **API sin contrato** (Fase 3 gap P0): `services/{productos,ordenes,stock}/src/routes/*.js` validaban a mano `if (!nombre || precio==null)` (bug `precio=0` falsy), sin `zod/joi`, sin middleware centralizado, sin `helmet/cors`, sin OpenAPI, sin versionado, sin paginación (`LIMIT 50` fijo sin `X-Total-Count/Link`), sin códigos de error estándar (`{ error: err.message }` leak 500 stack). Esto bloquea testing contract (`supertest` vs spec) + e2e + BFF aggregation (Fase 11.1 `GET /ordenes/:id?include=producto` requiere schema claro).

## Decision

**OpenAPI 3.1** `docs/openapi.yaml:1` + **versionado `/api/v1` + legacy `/api` compat** + **validación `zod`** + **`AppError` central** + **paginación cursor-like** + **`helmet/cors/compression/request-id`**:

- `docs/openapi.yaml:1` `openapi: 3.1.0` `servers: http://localhost:80` vía NGINX, tags `productos/ordenes/stock/health`, paths `/api/productos`, `/api/v1/productos`, `/api/ordenes`, `/api/v1/ordenes`, `/health/live|ready`, schemas `Producto/Orden/Stock` + `Error {code,message,details,requestId}` + `parameters Page/Limit/Sort` + `responses BadRequest/NotFound/InternalError/HealthOk`. Usado por `docs/api.md:1` + `frontend/app.js` + `docs/interview.md`.
- `services/productos/src/routes/productos.js:16` + `ordenes.js:40` + `stock.js:39` usan `validate(productoSchema)` `z.object({nombre: string 1-255, precio: coerce.number finite >=0, stock int >=0 default 0})` (`packages/shared/src/validate.js:8` Fase 3.3). Reemplaza `if (!nombre)` + fix falsy `stock ?? 0` (`productos.js:49` Fase 3.4) + `Number(precio)` finite.
- `packages/shared/src/errors.js:23` `class AppError(statusCode, code, message, details)` + `errorHandler` (log 5xx `logger.error` con `stack` + `requestId`, 4xx `warn`) + `notFoundHandler` → `{ error:{code,message,details,requestId}}` nunca expone pg stack a cliente (Fase 3.6).
- `GET /productos?` `parsePagination(req)` `?page&limit&sort` (`limit capped 100`, `offset`, `orderBy sortToOrderBy`) + `setPaginationHeaders(res, page, limit, total)` → `X-Total-Count`, `X-Page`, `X-Total-Pages`, `Link: <...>; rel="next"` (`packages/shared/src/pagination.js`, `services/productos/src/routes/productos.js:18` Fase 3.7).
- `GET /health/live` (sin DB `uptime_s`) vs `GET /health/ready` (DB `SELECT 1`) vs `GET /health` legacy readiness (`services/*/src/routes/health.js:18` Fase 3.8); ECS usa `ready`.
- `nginx/nginx.conf:111` `location ~ ^/api/productos(/.*)?$` + `location ~ ^/api/v1/productos(/.*)?$` (regex `(/.*)?$` evita `/api/productosmalicious`) → `proxy_pass http://productos/productos$1` (misma Express router montado en `services/productos/src/index.js:66` `app.use('/productos') + '/api/productos' + '/api/v1/productos'` Fase 3.2). NGINX y servicio mantienen ambos prefixes para compat.
- `packages/shared/src/middleware.js:48` `securityMiddleware()` → `helmet({contentSecurityPolicy:false}) + cors({origin: CORS_ORIGIN||*}) + compression() + requestIdMiddleware (uuid + AsyncLocalStorage) + createRateLimiter 100/min + trust proxy` (`services/*/src/index.js:24` Fase 3.5+8.3) + NGINX `limit_req_zone 30r/s burst 60 429` (`nginx.conf:14` Fase 8.4) defensa en profundidad.
- `GET /productos/:id` `PUT /:id` `DELETE /:id` + `GET /ordenes/:id?include=producto` BFF aggregation (Fase 10.5/11.1) siguen schema `Producto` + invalidan `cache productos:list:*` → `X-Cache HIT/MISS`.

Testing contract: `packages/test-helpers` + `jest` `coverageThreshold 80%` (`services/productos/package.json:44` Fase 4) + `supertest` contra OpenAPI via `openapi-validator` (Fase 4.6 futuro) + `scripts/e2e.sh:51` `?limit=2` + `X-Total-Count`/`Link` asserts.

## Consequences

### Positive

- **Contrato testeable:** `grep "if (!nombre"` =0 (Fase 3 métrica), `openapi.yaml` lint 0 errores (vs scaffold `undefined`), `POST /api/v1/productos {precio:0}` válido (falsy fix).
- **Versionado sin breaking:** clientes antiguos `/api/productos` siguen 200 (NGINX + Express alias), nuevos usan `/api/v1` documentado en `openapi.yaml` + `frontend/` usa `v1` (compatible entrevista "¿Cómo versionas sin romper?").
- **Paginación estándar:** `Link` + `X-Total-Count` permite `frontend/app.js` `loadProductos(page)` + `X-Cache` key `productos:list:${page}:${limit}:${sort}` (Fase 10.5) sin cardinalidad alta (`http_request_duration_ms` labels `route` normalizado `/:id` en `metrics.js:46`).
- **Errores consistentes:** 400 `VALIDATION_ERROR` con `details[{path,message,code}]`, 404 `NOT_FOUND`, 409 `STOCK_CONFLICT` (Fase 10.2), 429 `RATE_LIMITED` + `requestId` en cada error → `docs/observability.md:19` filter `requestId`.

### Negative

- **Doble mount:** mantener `/productos` + `/api/productos` + `/api/v1/productos` en Express (`index.js:66`) + NGINX regex duplica config (6 locations por servicio). Mitigado con template + test e2e cubre ambos.
- **OpenAPI drift:** `openapi.yaml` manual puede desync con `productoSchema` zod; Fase 4.6 `openapi-validator` supertest valida respuesta vs spec, pero no genera spec desde zod (alternativa `zod-to-openapi` rechazada para simplicidad).
- **Limit capped 100:** paginación `limit max 100` evita DoS pero requiere `Link` para cursor; no es cursor `after_id` — aceptable para portfolio (<1k rows), prod high-volume usaría `keyset` (`WHERE id > $cursor`).

### Trade-offs Accepted

> Mantenemos `openapi.yaml` manual + alias legacy `/api` vs generación `zod-to-openapi` porque el valor portfolio está en `curl` ejemplos `docs/api.md:63` y `frontend/app.js` consumo `v1` + `X-Total-Count`, no en codegen. Si el equipo crece, migrar a `zod-to-openapi` + `oas lint` en CI.

## Alternatives Considered

### 1. No versionado, solo `/api/productos` (rejected)

- Rápido pero breaking change en Fase 11 BFF `include` o `PUT` product requiere nuevo campo → clientes antiguos rompen. `/api/v1` permite deprecation header futuro (`Sunset`).

### 2. Joi vs Zod (chosen Zod)

- `joi` más verboso, `zod` coerce `z.coerce.number()` resuelve `precio=0` string→number + `finite()` + `default(0)` en una línea (Fase 3.4). `express-validator` rejected por middleware disperso vs `validate(schema)` factory.

### 3. GraphQL vs REST OpenAPI (rejected)

- GraphQL aporta aggregation BFF nativa pero requiere schema + resolvers + DataLoader — overkill para 3 CRUD services. REST + `GET /ordenes/:id?include=producto` (Fase 11.1) cubre BFF con circuit breaker + cache.

### 4. Cursor pagination `after_id` vs `page/limit` (chosen page/limit)

- `page/limit` más simple con `COUNT(*)` + `X-Total-Count` para frontend simple; cursor `after_id` mejor para high-volume sin `COUNT(*)` costoso — documentado como evolución prod en `docs/data-model.md`.

### 5. Generación OpenAPI desde zod (`zod-to-openapi`) vs manual yaml (chosen manual)

- Generación garantiza sync pero añade build step `zodToOpenAPI(productoSchema)` y dependencia. Manual `openapi.yaml` es legible en entrevista 60s y `prettier` no lo formatea — simplicidad preferida.

## References

- `docs/openapi.yaml:1` + `docs/api.md:1` + `docs/requests.http`
- `packages/shared/src/validate.js:8` + `services/productos/src/routes/productos.js:46` + `services/ordenes/src/routes/ordenes.js:40` + `services/stock/src/routes/stock.js:39`
- `packages/shared/src/errors.js:23` + `services/*/src/index.js:71` `notFoundHandler/errorHandler`
- `services/*/src/routes/health.js:18` live/ready + `nginx/nginx.conf:111` versioned locations + `nginx.local.conf:87`
- `packages/shared/src/pagination.js` + `services/productos/src/routes/productos.js:18` `X-Total-Count/Link`
- `packages/shared/src/middleware.js:48` `helmet/cors/compression/requestId` + `nginx.conf:14` `limit_req_zone`
- `frontend/app.js:23` `loadProductos` + `X-Cache`
- `services/ordenes/src/routes/ordenes.js:152` BFF `include=producto`
- `PLAN_ELEVACION_11_FASES.md:114` Fase 3
