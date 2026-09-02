# Demo — ERP Pipeline (Fase 11.3)

> 2m demo del flujo completo: compose up → frontend → API → BFF → cache → chaos.
> Loom: `https://loom.com/share/erp-pipeline-demo` (placeholder — grabar con `make dev` + `frontend/`).
> Gif: `docs/screenshots/demo.gif` (generar con `peek` o `ScreenToGif` 800x450, <5MB).

## One-liner

```bash
git clone https://github.com/Francisco-cor/Pipeline_CI-CD_IaC && cd Pipeline_CI-CD_IaC
cp .env.example .env && nvm use && npm install
docker compose up --build -d --wait && docker compose --profile frontend up -d --build
open http://localhost:8080  # frontend
open http://localhost:80/health  # nginx
```

## Flujo 120s (para Loom)

1. **0:00 Health** `curl http://localhost:80/health | jq` → nginx ok + `http://localhost:8080` frontend muestra 4 health verdes (60fps).
2. **0:20 Productos cache** `curl -i http://localhost:80/api/v1/productos?limit=1 | grep X-Cache` → MISS, segunda → HIT; create producto via frontend → MISS again (invalidate `productos:list:*`).
3. **0:40 Orden BFF** crea orden con `producto_id` válido → `POST /api/v1/ordenes 201` + `GET /api/v1/ordenes/:id?include=producto` → `{ data: orden, producto: {...}, _bff: "orden+producto aggregated" }` (Fase 11.1). Muestra circuit stats `GET /api/v1/ordenes/_circuit`.
4. **1:00 Stock TX** `POST /api/v1/stock {tipo:"salida",cantidad:100}` con stock 3 → `409 STOCK_CONFLICT` (trigger 005); luego `entrada 5` → 201 + cache invalidado.
5. **1:20 Metrics** `curl http://localhost:3001/metrics | grep http_request_duration` + `http://localhost:3001/health/details | jq .pool` + `http://localhost:80/api/v1/bff/ordenes/:id` (gateway profile `docker compose --profile gateway up`).
6. **1:40 Chaos** `./scripts/chaos.sh http://localhost:80 all` → kill-productos fallback 404, cache, 409; `k6 run scripts/k6/resilience.js -e BASE_URL=http://localhost:80` p95<300ms.
7. **1:55 Observabilidad** `docker compose logs productos | jq 'select(.requestId=="…")'` + CloudWatch dashboard screenshot `docs/screenshots/cloudwatch.png` (Fase 9) + Jaeger `http://localhost:16686`.

## Screenshots (refresh Fase 11.3)

| Archivo | Que muestra | Cómo generar |
|---|---|---|
| `docs/screenshots/aws_console.png` | ECS cluster `erp-pipeline-dev-cluster` con 1 task running, 5 containers | AWS Console → ECS → Clusters → screenshot 1280x720 |
| `docs/screenshots/cloudwatch.png` | Dashboard `erp-pipeline-dev-overview` 6 widgets + `filter level=error` | CloudWatch → Dashboards → screenshot |
| `docs/screenshots/github_actions.png` | Actions `pipeline.yml` verde `<6m` con 9 jobs | GitHub → Actions → workflow run → screenshot |
| `docs/screenshots/json_productos_api.png` | `GET /api/v1/productos?limit=2` con `X-Total-Count` + `Link` | `curl | jq` screenshot |
| `docs/screenshots/json_ordenes_api.png` | `GET /api/v1/ordenes/:id?include=producto` BFF `{data, producto, _bff}` | `curl | jq` screenshot |
| `docs/screenshots/demo.gif` | Flow frontend 800x450 <5MB: health → productos → orden BFF → stock 409 → metrics | `peek`/`LICEcap` 15s @10fps |
| `frontend/` | Dashboard `http://localhost:8080` con cards productos/ordenes/stock + health | browser screenshot 1280x720 |

> Para portfolio sin AWS, basta `docker compose` + `frontend/` + `e2e.sh` verde. Los screenshots AWS pueden ser mocks con anotación “staging, toggles `enable_alb=false` FinOps”.

## Comandos demo local (copiar en Loom descripción)

```bash
# 1. Up + seed
docker compose up --build -d --wait
curl http://localhost:80/api/v1/productos | jq .total

# 2. Cache
curl -i http://localhost:80/api/v1/productos?limit=1 | grep -i x-cache
curl -X POST http://localhost:80/api/v1/productos -H "Content-Type: application/json" -d '{"nombre":"demo","precio":9.9,"stock":2}' | jq

# 3. BFF
ID=$(curl -s http://localhost:80/api/v1/productos | jq -r '.data[0].id')
curl -s -X POST http://localhost:80/api/v1/ordenes -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":1,\"total\":9.9}" | jq
ORD=$(curl -s http://localhost:80/api/v1/ordenes | jq -r '.data[0].id')
curl "http://localhost:80/api/v1/ordenes/$ORD?include=producto" | jq
curl "http://localhost:80/api/v1/bff/ordenes/$ORD" | jq  # con gateway profile

# 4. Stock invariant
curl -s -X POST http://localhost:80/api/v1/stock -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":999,\"tipo\":\"salida\"}" | jq # 409
curl -s http://localhost:3001/health/details | jq .pool
curl -s http://localhost:3001/metrics | grep http_request_duration

# 5. Chaos + load
./scripts/chaos.sh http://localhost:80 all
k6 run scripts/k6/resilience.js -e BASE_URL=http://localhost:80
```

## Checklist antes de grabar

- [ ] `make verify` verde (lint + prettier + compose config + tf validate)
- [ ] `docker compose down -v && docker compose up --build -d --wait` <180s
- [ ] `scripts/e2e.sh http://localhost:80` PASS
- [ ] `frontend/` abre en 8080 sin CORS error (headers `X-Request-Id` visibles)
- [ ] `demo.gif` <5MB, 800x450, muestra `X-Cache HIT` y `include=producto`

Ver `docs/interview.md:1` para preguntas que el demo responde y `docs/openapi.yaml:1` para contrato.
