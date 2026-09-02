# Observabilidad — ERP Pipeline (Fase 9)

> Sin `ssh`: logs, métricas, traces y health para triagear alarmas en <5m. Ver `docs/runbooks/` y `terraform/dashboard.tf:1`.

## Stack

| Capa | Qué | Dónde |
|---|---|---|
| **Logs** | JSON `logger.js:14` `requestId` via `AsyncLocalStorage` + `requestIdMiddleware` + `X-Request-Id` header | CloudWatch `/ecs/erp-pipeline-{env}` retention 7d dev / 90d prod (`compute/main.tf:110`) |
| **Métricas** | `prom-client` `http_request_duration_ms` (histogram) + `http_requests_total` + `http_active_requests` + EMF `HttpLatency/HttpRequestCount` → CloudWatch Metrics (`metrics.js:20`) | `GET /metrics` per-service + EMF via logs |
| **Dashboard** | 6 widgets CPU/Mem/Error/Latency p95/5xx/DB conns + log table top errors (`dashboard.tf:10`) | CloudWatch `erp-pipeline-{env}-overview` |
| **Alarmas** | `ServiceErrorCount>10/5m`, `p95>500ms`, `5xx>10/5m`, `DBConnections>80` → SNS `alert_email` (`observability.tf:49-110`) | SNS + `aws logs tail` |
| **Tracing** | OTel SDK `NodeSDK` + `auto-instrumentations` + `OTLPTraceExporter` (`tracing.js:20`) → X-Ray/OTel collector si `OTEL_ENABLED=true` | `http://localhost:4318/v1/traces` |
| **Health** | `/health` (readiness DB), `/health/live` (liveness), `/health/ready`, `/health/details` pool stats (`health.js:60`) | ECS + k8s probes |

---

## Logs — correlation-id

**Flow:** `X-Request-Id` header in → `requestIdMiddleware` (`middleware.js:12`) `storage.enterWith({requestId})` → `logger.info` lee `storage.getStore().requestId` (`logger.js:15`) → JSON `requestId` en cada línea → NGINX `proxy_set_header X-Request-Id $request_id` → CloudWatch.

**Verificación local:**

```bash
curl -i http://localhost:80/api/v1/productos | grep X-Request-Id
curl -H "X-Request-Id: my-id-123" http://localhost:80/api/v1/productos/health | jq
docker compose logs productos | jq 'select(.requestId=="my-id-123")'
```

**CloudWatch Logs Insights (copiar en console → Logs Insights → /ecs/erp-pipeline-dev):**

```sql
# Top errores por servicio (dashboard widget 5)
fields @timestamp, level, service, message, requestId
| filter level="error"
| stats count() as c by service, message
| sort c desc | limit 5

# Búsqueda por requestId (triaje)
fields @timestamp, level, service, message, requestId, ms, status
| filter requestId="my-id-123"
| sort @timestamp desc

# Latencia lenta (>500ms) con requestId
fields @timestamp, service, ms, status, requestId, path
| filter message="http_request" and ms > 500
| sort ms desc | limit 20
```

**Retention:** `terraform/modules/compute/main.tf:110` `7` dev / `14` staging / `90` prod. Cambia `var.environment` o edita `retention_in_days`.

---

## Métricas — prom-client + EMF

**Endpoints:**

```bash
curl http://localhost:3001/metrics | head -n 20  # directo
curl http://localhost:80/api/productos/metrics | head # via NGINX
curl http://localhost:80/metrics | head         # alias productos
```

**Métricas clave:**

| Métrica | Tipo | Labels | Origen |
|---|---|---|---|
| `http_request_duration_ms_bucket` | Histogram | `method,route,status` | `metrics.js:20` |
| `http_requests_total` | Counter | `method,route,status` | `metrics.js:30` |
| `http_active_requests` | Gauge | — | `metrics.js:36` |
| `erp_http_latency` | EMF `HttpLatency` | `ServiceName,Route` | EMF log `_aws` |
| `erp_http_5xx` | Metric filter `Http5xxCount` | — | `observability.tf:80` |

**Prometheus scrape (opcional local):**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'erp'
    static_configs:
      - targets: ['localhost:3001','localhost:3002','localhost:3003']
    metrics_path: /metrics
```

**EMF — CloudWatch Metrics via Logs:**

Cada `http_request` loggea además un objeto EMF con `_aws` (`metrics.js:50`):

```json
{"_aws":{"Timestamp":1234567890123,"CloudWatchMetrics":[{"Namespace":"erp-pipeline/dev","Dimensions":[["ServiceName","Route"]],"Metrics":[{"Name":"HttpLatency","Unit":"Milliseconds"}]}]},"ServiceName":"svc-productos","Route":"/api/v1/productos","HttpLatency":42}
```

CloudWatch extrae `HttpLatency` automáticamente sin agente. Ver en **Metrics → erp-pipeline/dev**.

---

## Dashboard — `terraform/dashboard.tf:10`

6 widgets (ver `dashboard.tf`):

1. **ECS CPU/Mem** — `AWS/ECS` `CPUUtilization`/`MemoryUtilization` `ClusterName=erp-pipeline-{env}-cluster` 5m `Average`
2. **ServiceErrorCount** — `${project}/${env}` `Sum` 5m, threshold 10 (rojo)
3. **HttpLatency p95 + 5xx** — EMF `HttpLatency p95` + `Http5xxCount Sum` 5m, annot `500ms`
4. **RDS DBConnections + CPU** — `AWS/RDS` `DatabaseConnections` `Maximum` + `CPUUtilization` `DBInstanceIdentifier=erp-pipeline-{env}-postgres`
5. **Logs — Top 5 errors** — Insights `filter level=error | stats count() by service,message`
6. **Latency percentiles** — `p50/p95/p99` de `HttpLatency`

**Crear/ver:**

```bash
terraform -chdir=terraform init -backend-config=environments/backend-dev.hcl
terraform -chdir=terraform apply -var-file=environments/dev.tfvars  # crea dashboard
aws cloudwatch get-dashboard --dashboard-name erp-pipeline-dev-overview --region us-east-2
# Console: https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#dashboards:name=erp-pipeline-dev-overview
```

**Coste:** $3/mes por dashboard (AWS cobra a partir de 3 widgets). En dev puedes no desplegar si quieres $0, pero Fase 9 lo deja habilitado para demo.

---

## Alarmas — `terraform/observability.tf:49-150`

| Alarma | Métrica | Umbral | Acción |
|---|---|---|---|
| `high-error-rate` | `ServiceErrorCount` `Sum 5m` | `>10` | SNS `alerts` |
| `high-latency-p95` | `HttpLatency` `p95 5m` | `>500ms` | SNS |
| `high-5xx-rate` | `Http5xxCount` `Sum 5m` | `>10` | SNS |
| `db-connections-high` | `AWS/RDS DatabaseConnections` `Maximum 5m` | `>80` | SNS |

Todas: `treat_missing_data=notBreaching` + `ok_actions` para cerrar.

**SNS:** `observability.tf:17` `aws_sns_topic.alerts` + `email` subscription si `alert_email` seteado en `environments/*.tfvars`. Confirma email tras `apply`.

**Test alarma (<5m):**

```bash
# Genera 11 errores para disparar high-error-rate
for i in {1..11}; do curl -s http://localhost:80/api/v1/productos -H "Content-Type: application/json" -d '{"nombre":"","precio":-1}' >/dev/null; done
# Verifica: debe loggear level=error y metric filter incrementa
aws cloudwatch describe-alarms --alarm-names erp-pipeline-dev-high-error-rate --query 'MetricAlarms[0].StateValue'
# Debe pasar a ALARM en <5m; luego a OK cuando paren errores
```

**Runbook triaje:** ver `docs/runbooks/alert.md:1` (Fase 9.8) — pasos: Logs Insights → `requestId` → `pool.details` → `metrics` → `rollback` si needed.

---

## Tracing — `packages/shared/src/tracing.js:1` (Fase 9.6)

**Init:** `services/*/src/index.js:3` `initTracing(serviceName)` antes de cualquier `require` instrumentado. Usa `NodeSDK` + `getNodeAutoInstrumentations` (http, express, pg) + `OTLPTraceExporter`.

**Env toggles:**

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces  # OTel collector / Jaeger / ADOT
OTEL_SERVICE_NAME=svc-productos
TRACE_SAMPLE_RATIO=0.1  # 10% en prod para coste
```

- `OTEL_ENABLED=false` (default dev) → tracing deshabilitado, sin overhead, no rompe si deps faltan (try/catch).
- En prod con `OTEL_ENABLED=true` y collector, traces aparecen en **X-Ray** (si ADOT) o **Jaeger** (`http://localhost:16686`).

**Local con Jaeger:**

```bash
docker run -d --name jaeger -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one:latest
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces npm run dev
# Genera tráfico
curl http://localhost:80/api/v1/productos
# Ver traces: http://localhost:16686
```

**Coleta ECS (prod):** añade sidecar `aws-otel-collector` en `taskdef.json.tftpl` (Fase 10) con `executionRole` permiso `xray:PutTraceSegments`.

---

## Health — `services/*/src/routes/health.js:60` (Fase 9.7)

| Endpoint | Qué | DB |
|---|---|---|
| `GET /health` | readiness `SELECT 1` + `latency_ms` + `uptime_s` | sí |
| `GET /health/live` | liveness `uptime_s` | no |
| `GET /health/ready` | alias readiness | sí |
| `GET /health/details` | `status, service, db, latency_ms, uptime_s, memory (rss/heap), pool {totalCount,idleCount,waitingCount}, version, requestId` | sí (pero responde con `pool` incluso si DB down) |
| `GET /metrics` | Prometheus `http_*` | no |

**Uso ECS:**

- `compute/main.tf` `healthCheck` usa `/health` (readiness)
- Futuro: `live` para `livenessProbe` en k8s, `ready` para `readinessProbe`

**Verificación:**

```bash
curl http://localhost:3001/health/details | jq
# {
#   "status": "ok",
#   "service": "svc-productos",
#   "db": "connected",
#   "latency_ms": 2,
#   "uptime_s": 123,
#   "memory": { "rss": 456..., "heapUsed": 123... },
#   "pool": { "totalCount": 1, "idleCount": 0, "waitingCount": 0 },
#   "version": "dev",
#   "requestId": "uuid..."
# }
curl http://localhost:80/api/productos/health/details | jq .pool
```

**NGINX proxy:** `nginx.conf:45` y `nginx.local.conf:30` exponen `/health/details` y `/metrics` per-service + global alias.

---

## Verificación local completa (Fase 9 métrica)

```bash
make dev # o docker compose up --build -d --wait
# 1. Logs + correlation-id
curl -H "X-Request-Id: test-123" http://localhost:80/api/v1/productos | jq
docker compose logs productos | jq 'select(.requestId=="test-123")' | head

# 2. Metrics + EMF
curl -s http://localhost:3001/metrics | grep http_request_duration
docker compose logs productos | grep -m1 '"_aws"' | jq

# 3. Health details + pool
curl -s http://localhost:3001/health/details | jq '.pool, .memory'

# 4. Dashboard (si terraform apply hecho)
aws cloudwatch get-dashboard --dashboard-name erp-pipeline-dev-overview --region us-east-2 | jq '.DashboardBody | fromjson | .widgets | length' # debe ser 6

# 5. Alarma <5m
for i in {1..11}; do curl -s -X POST http://localhost:80/api/v1/productos -H "Content-Type: application/json" -d '{"nombre":"","precio":-1}' >/dev/null; done; echo "11 errors sent — espera 5m y revisa SNS / console"
```

## Costes

- Logs retention 7d dev ($0.03/GB) vs 90d prod
- Dashboard $3/mes
- Alarms $0.10/mes cada una (4 = $0.40)
- Tracing si `OTEL_ENABLED=false` $0; si true, OTel collector + X-Ray $5/100k traces (sampling 10% reduce)
- Total Fase 9 dev: ~$3.50/mes extra (aceptado para observabilidad)

## Referencias

- `packages/shared/src/logger.js:14` + `middleware.js:12` correlation-id
- `packages/shared/src/metrics.js:20` prom-client + EMF
- `terraform/dashboard.tf:10` 6 widgets
- `terraform/observability.tf:49-150` 4 alarmas + 2 metric filters
- `packages/shared/src/tracing.js:20` OTel SDK
- `services/*/src/routes/health.js:60` details
- `nginx/nginx.conf:45` metrics/health proxy
