# API — ERP Pipeline (Fase 3)

> Base URL local: `http://localhost:80` (NGINX). También directo `http://localhost:3001|3002|3003`.
> Spec: `docs/openapi.yaml:1` (OpenAPI 3.1).

## Versionado

- **Legacy compat:** `/api/productos`, `/api/ordenes`, `/api/stock` (proxy a `/productos` etc.)
- **Versioned:** `/api/v1/productos` (recomendado) — mismo handler, mismo `router` montado en `services/productos/src/index.js:29-33`.
- NGINX mantiene ambos (ver `nginx/nginx.conf:44-56`, `nginx.local.conf:36-54`). Servicios montan `/productos` + `/api/productos` + `/api/v1/productos`.

## Health

| Endpoint                                    | Descripción                                      |
| ------------------------------------------- | ------------------------------------------------ |
| `GET /health`                               | NGINX liveness                                   |
| `GET /api/productos/health`                 | readiness (DB `SELECT 1`) — alias legacy         |
| `GET /api/v1/productos/health`              | alias versioned                                  |
| `GET /health/live`                          | liveness sin DB (`uptime_s`) — ECS `healthCheck` |
| `GET /health/ready`                         | readiness (DB + draining) — 503 durante shutdown |
| `GET /api/productos/health/live` y `/ready` | via NGINX                                        |

El contenedor usa `/health/live` para liveness (un failover de RDS no debe reiniciar
la tarea en bucle). `/health/ready` devuelve 503 mientras el proceso drena tras
`SIGTERM`; el ALB deja de enviar tráfico antes de cerrar el server.

## Paginación (Fase 3.7)

`GET /api/v1/productos?page=1&limit=20&sort=created_at_desc`

- `page` 1..10000 default 1, `limit` 1..100 default 20, `sort` `created_at_desc|created_at_asc`
- El orden es determinístico (`created_at, id`) y usa índices compuestos (`010_pagination_indexes.sql`).
- Headers: `X-Total-Count`, `X-Page`, `X-Limit`, `X-Total-Pages`, `Link: <...>; rel="next"`
- Body compat: `{ data: [], count: <pageSize>, total, page, limit }` — `count` mantenido para tests antiguos.

## Validación (Fase 3.3)

Zod en `packages/shared/src/validate.js:8-35` + `validate(schema)` middleware.

- `POST /api/v1/productos` → `productoCreateSchema` (`nombre` 1-255, `precio` 0..99999999.99, `stock` inicial opcional)
- `PUT /api/v1/productos/:id` → `productoUpdateSchema` (solo `nombre`/`precio`; **nunca** `stock`)
- `POST /api/v1/ordenes` → `ordenSchema` (`producto_id`, `cantidad`; `total` es advisory y se calcula en servidor)
- `POST /api/v1/stock` → `stockSchema` (`tipo` enum, `cantidad` 1..2147483647)

Error 400 → `{ error: { code: "VALIDATION_ERROR", message, details:[{path,message,code}], requestId } }`

## Stock como ledger

`productos.stock` es una proyección de `movimientos_stock`, no un campo editable:

- `POST /productos` con `stock>0` inserta el producto en 0 y un movimiento `entrada` inicial en la misma transacción.
- `PUT /productos/:id` ignora `stock`; para ajustar inventario usar `POST /stock`.
- `POST /ordenes` inserta `salida` en la misma transacción que la orden, bajo `SELECT ... FOR UPDATE`; si no hay stock devuelve `409 STOCK_CONFLICT` y no crea la orden.
- El trigger `005_stock_invariant.sql` es el único escritor de `productos.stock`; un consumer SQS no vuelve a descontar.

## Idempotencia

`POST /api/v1/ordenes` y `POST /api/v1/stock` aceptan `Idempotency-Key`.

- Misma key + mismo body → se replaya la respuesta original (`Idempotent-Replayed: true`).
- Misma key + body distinto → `409 IDEMPOTENCY_KEY_REUSED`.
- Key en progreso → `409 IDEMPOTENCY_IN_PROGRESS` con `Retry-After`.
- Las respuestas 5xx liberan la key; TTL de limpieza 24 h (`IDEMPOTENCY_TTL_HOURS`).

## Errores de dominio

| Código                    | HTTP | Cuándo                                           |
| ------------------------- | ---- | ------------------------------------------------ |
| `STOCK_CONFLICT`          | 409  | salida/orden sin stock suficiente                |
| `CONFLICT`                | 409  | unique/FK constraint (`23505`/`23503`)           |
| `VALIDATION_ERROR`        | 400  | Zod, JSON malformado, overflow (`22P02`/`22003`) |
| `IDEMPOTENCY_KEY_REUSED`  | 409  | misma key con otro body                          |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | request original aún en vuelo                    |

## Fix falsy (Fase 3.4)

- `stock ?? 0` en `productos.js:24` (no `stock || 0` que rompe `stock=0`)
- `z.coerce.number` + `finite()` para `precio=0` válido (antes `if (!nombre || precio==null)` perdía 0)

## Autenticación y autorización (Fase 2 seguridad)

Las rutas de datos (`/api/productos`, `/api/v1/ordenes`, `/api/v1/stock`, etc.)
requieren `Authorization: Bearer <JWT>` cuando `AUTH_ENABLED` está activo.

| Rol        | Lecturas | POST/PUT | DELETE |
| ---------- | -------- | -------- | ------ |
| `reader`   | ✅       | ❌ 403   | ❌ 403 |
| `operator` | ✅       | ✅       | ❌ 403 |
| `admin`    | ✅       | ✅       | ✅     |

- Algoritmos: HS256 con `JWT_SECRET` (default) o RS256 con `JWT_PUBLIC_KEY`.
- Claims: `sub`, `role`, `tenant_id` (o `tenantId`), `scopes` (array o string).
- `AUTH_ENABLED` default: `true` en `prod`/`production`, `false` en dev/test.
  Con auth activa y sin clave de verificación el servicio **no arranca**
  (`assertAuthConfig`) o devuelve `503 AUTH_NOT_CONFIGURED` si ya está corriendo.
- Sin token / token inválido → `401 UNAUTHORIZED` / `INVALID_TOKEN` /
  `TOKEN_EXPIRED`; rol insuficiente → `403 FORBIDDEN`.
- Rutas públicas: `GET /` (metadata), `/health`, `/health/live`,
  `/health/ready`. `/metrics`, `/health/details`, `/_circuit` y `/bff/health`
  son diagnósticos y devuelven 404 en prod (`ENABLE_DIAGNOSTICS=false`).
- `scopes` se validan aparte con `requireScope(...)` cuando un endpoint lo
  necesita.

### Token local

```bash
export JWT_SECRET=dev-only-secret
TOKEN=$(node scripts/issue-token.js --sub alice --role admin --tenant acme)
curl -H "Authorization: Bearer $TOKEN" http://localhost:80/api/v1/productos
```

### Audit log

Las mutaciones (`POST`/`PUT`/`PATCH`/`DELETE`) se registran en `audit_log`
(`011_audit_log.sql`) con `actor_sub`, `actor_role`, `tenant_id`, `action`
(`post:productos`), `resource`, `resource_id`, `status`, `request_id` y
`metadata` JSONB. El insert es best-effort: si falla, se loguea
`audit_write_failed` y la respuesta original no se altera. `AUDIT_ENABLED=false`
desactiva la escritura (no recomendado en prod).

## Seguridad de transporte y borde (Fase 2 seguridad)

- `rds.force_ssl=1` en el parameter group; la app usa `sslmode`/CA bundle en prod.
- Redis: `rediss://` + AUTH token generado por Terraform, cifrado en tránsito y
  en reposo; la URL vive en SSM (`/erp/<env>/redis-url`) y ECS la inyecta como
  secreto.
- SQS: SSE administrado + política que deniega transporte sin TLS.
- CORS: `CORS_ORIGIN` es una allowlist separada por comas. En prod sin
  allowlist no se emite `Access-Control-Allow-Origin` (fail closed); dev/test
  mantienen `*`.
- Rate limit detrás del ALB: NGINX configura `real_ip` con rangos privados,
  `real_ip_header X-Forwarded-For`, `real_ip_recursive on`; el hop BFF reescribe
  `X-Forwarded-For` con `$remote_addr`. `TRUST_PROXY` configurable
  (`1` por defecto, `false`, número de hops o CIDRs).
- NGINX de prod devuelve 404 para `/metrics`, `/health/details`,
  `/bff/health` y sus alias; `nginx.local.conf` conserva el acceso para dev.

## Seguridad (Fase 3.5)

- `helmet` + `cors` (allowlist `CORS_ORIGIN`) + `compression` + `requestIdMiddleware` (`uuid`) en `packages/shared/src/middleware.js`
- Cada request loguea `requestId` (`services/productos/src/index.js`)
- NGINX añade `X-Content-Type-Options`, `X-Frame-Options`, etc. (`nginx.conf`)
- Response header `X-Request-Id`
- Diagnósticos gateados por `ENABLE_DIAGNOSTICS` (default false en prod).

## Errores (Fase 3.6)

Central `errorHandler` en `packages/shared/src/errors.js:23-50` + `notFoundHandler`.

- 4xx → `warn` log, 5xx → `error` log + `stack`
- 500 nunca expone `err.message` si no es `AppError` operacional → `internal error`
- 404 → `{ error: { code: "NOT_FOUND", message: "route ... not found", requestId } }`

## Ejemplos

```bash
# Health
curl -i http://localhost:80/health
curl -i http://localhost:80/api/v1/productos/health
curl -i http://localhost:80/api/v1/productos/health/live

# Productos paginado
curl "http://localhost:80/api/v1/productos?page=2&limit=5&sort=created_at_asc" -i
# Headers: X-Total-Count, Link

# Crear producto (precio 0 y stock 0 válidos — test falsy fix)
curl -X POST http://localhost:80/api/v1/productos \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Tornillo M8","precio":0,"stock":0}' | jq

# Validación 400
curl -X POST http://localhost:80/api/v1/productos \
  -H "Content-Type: application/json" \
  -d '{"nombre":"","precio":-5}' | jq
# => { error: { code:"VALIDATION_ERROR", details:[...] } }

# Orden con FK 404
curl -X POST http://localhost:80/api/v1/ordenes \
  -H "Content-Type: application/json" \
  -d '{"producto_id":9999,"cantidad":2}' | jq

# Orden idempotente: reintentar con la misma key devuelve la misma orden
curl -X POST http://localhost:80/api/v1/ordenes \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: orden-2026-0001" \
  -d '{"producto_id":1,"cantidad":2}' | jq

# Stock (el PUT de productos ya no cambia stock; usar movimientos)
curl -X POST http://localhost:80/api/v1/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: stock-2026-0001" \
  -d '{"producto_id":1,"cantidad":5,"tipo":"entrada"}' | jq
```

## Colecciones

- `docs/requests.http` — VS Code REST Client
- `docs/bruno/collection.json` — Bruno (ver `docs/api.http`)
- Importar `docs/openapi.yaml` en Insomnia/Postman.

## Compatibilidad

- Clientes antiguos usando `/api/productos` siguen funcionando (NGINX proxy legacy + servicio monta `/api/productos`).
- Nuevos usar `/api/v1/...` (documentado en OpenAPI).
