# Observabilidad — ERP Pipeline (Fase 9)

> Sin `ssh`: logs, métricas, traces y health para triagear alarmas en <5m. Ver `docs/runbooks/` y `terraform/dashboard.tf:1`.

## Stack

| Capa          | Qué                                                                                                                                                                               | Dónde                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Logs**      | JSON `logger.js:14` `requestId` via `AsyncLocalStorage` + `requestIdMiddleware` + `X-Request-Id` header                                                                           | CloudWatch `/ecs/erp-pipeline-{env}` retention 7d dev / 90d prod (`compute/main.tf:110`) |
| **Métricas**  | `prom-client` `http_request_duration_ms` (histogram) + `http_requests_total` + `http_active_requests` + EMF `HttpLatency/HttpRequestCount` → CloudWatch Metrics (`metrics.js:20`) | `GET /metrics` per-service + EMF via logs                                                |
| **Dashboard** | 6 widgets CPU/Mem/Error/Latency p95/5xx/DB conns + log table top errors (`dashboard.tf:10`)                                                                                       | CloudWatch `erp-pipeline-{env}-overview`                                                 |
| **Alarmas**   | `ServiceErrorCount>10/5m`, `p95>500ms`, `5xx>10/5m`, `DBConnections>80` → SNS `alert_email` (`observability.tf:49-110`)                                                           | SNS + `aws logs tail`                                                                    |
| **Tracing**   | OTel SDK `NodeSDK` + `auto-instrumentations` + `OTLPTraceExporter` (`tracing.js:20`) → X-Ray/OTel collector si `OTEL_ENABLED=true`                                                | `http://localhost:4318/v1/traces`                                                        |
| **Health**    | `/health` (readiness DB), `/health/live` (liveness), `/health/ready`, `/health/details` pool stats (`health.js:60`)                                                               | ECS + k8s probes                                                                         |

---

## SLIs, SLOs y error budget

Un SLO sin ventana, presupuesto y acción asociada es solo un número. Esta sección define **qué medimos** (SLI), **cuánto prometemos** (SLO), **cuánto podemos fallar** (error budget) y **qué alarma lo vigila** (page vs ticket).

### SLIs

| SLI                     | Definición                                                                                              | Fuente                                                                                                | Ventana de evaluación       |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| **Disponibilidad**      | `1 - (5xx / requests)` para tráfico HTTP válido. Un 5xx o un target sin healthy host cuenta como fallo. | `AWS/ApplicationELB` `RequestCount`, `HTTPCode_Target_5XX_Count`, `UnHealthyHostCount`                | 5m / 1h / 6h / 3d (rolling) |
| **Tasa 5xx**            | `HTTPCode_Target_5XX_Count / RequestCount * 100` (porcentaje).                                          | Metric math sobre ALB; en modo sin ALB, `Http5xxCount` (metric filter) sobre el total de requests EMF | 5m / 1h / 6h / 3d (rolling) |
| **Latencia p95**        | Percentil 95 de `TargetResponseTime` (ALB) o `HttpLatency` (EMF, app) en una ventana de 5m.             | `AWS/ApplicationELB` `TargetResponseTime` `p95`; `${project}/${env}` `HttpLatency` `p95`              | 5m / 1h / 6h / 3d (rolling) |
| **Frescura de la cola** | Edad del mensaje más viejo en la cola de órdenes (solo si `enable_sqs`).                                | `AWS/SQS` `ApproximateAgeOfOldestMessage`                                                             | 5m                          |
| **Tareas vivas**        | `RunningTaskCount >= DesiredCount` para el servicio ECS.                                                | `AWS/ECS` `RunningTaskCount`, `DesiredCount`                                                          | 1m                          |

La disponibilidad y la tasa 5xx son dos vistas del mismo contrato: disponibilidad es el complemento de la tasa de error. Se mantienen separadas porque la primera incluye "no hay target sano" (fallo total) y la segunda mide respuestas 5xx reales.

### SLOs propuestos

| SLO                   | Objetivo mensual       | Error budget (30 días)                                            | Justificación                                                                                                |
| --------------------- | ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Disponibilidad**    | **99.9%**              | **43m 12s** de indisponibilidad total; ~0.1% de requests fallidos | Un solo AZ y RDS single-AZ no sostienen 99.95%. 99.9% es defendible con el circuito de rollback de ECS.      |
| **Tasa 5xx**          | **< 1%** de requests   | 1% del volumen mensual de requests                                | Alineado con el budget de disponibilidad; evita paging por dos 5xx aislados y detecta fallos sistémicos.     |
| **Latencia p95**      | **< 300ms**            | 5% de requests pueden superar 300ms (si se mide por request)      | `GET /productos` con índice trigram y pool pequeño debe quedar muy por debajo; 300ms deja margen a RDS frío. |
| **Frescura de cola**  | p95 < 5 min            | 5% de ventanas de 5m pueden superar 5 min                         | El outbox es asíncrono; 5 min es el punto donde el usuario ya percibe la orden como "perdida".               |
| **Recuperación (DR)** | RTO ≤ 2h, RPO ≤ 15 min | N/A (se valida con restore drill)                                 | Ver `docs/runbooks/restore.md`; el RPO real es el `LatestRestorableTime` de RDS.                             |

Los umbrales de las alarmas son **más laxos** que el SLO a propósito: una alarma de página al 500ms no espera a agotar el presupuesto de 300ms; dispara cuando el burn rate ya es insostenible, y el SLO se evalúa con la ventana completa.

### Error budget y burn rate

El error budget mensual se calcula sobre una ventana móvil de 30 días:

```text
budget_disponibilidad = (1 - 0.999) * 30d = 43m 12s
budget_5xx            = 0.01 * requests_mensuales
budget_latencia       = 0.05 * requests_mensuales (p95 < 300ms)
```

Burn rate = `error_rate_observado / error_rate_permitido`. Para 99.9%, el burn rate 1 consume el 100% del budget en 30 días; 14.4 lo consume en ~2 días (1h de observación = 2% del budget).

| Ventana larga | Ventana corta | Burn rate | Budget consumido | Acción            | Alarmas que lo cubren                                                                 |
| ------------- | ------------- | --------- | ---------------- | ----------------- | ------------------------------------------------------------------------------------- |
| 1h            | 5m            | **14.4x** | 2% en 1h         | **Page (SEV1)**   | `alb-5xx-ratio`, `high-error-rate`, `ecs-running-tasks-low`, `alb-unhealthy-hosts`    |
| 6h            | 30m           | **6x**    | 5% en 6h         | **Page (SEV2)**   | `high-5xx-rate`, `alb-latency-p95`, `high-latency-p95`, `db-connections-high`         |
| 3d            | 6h            | **1x**    | 10% en 3d        | **Ticket (SEV3)** | `rds-cpu-high`, `rds-free-storage-low`, `waf-blocked-requests-high`, `sqs-*`          |
| 30d           | —             | 1x        | 100% en 30d      | Revisión semanal  | Dashboard + Budgets; no hay alarma dedicada porque no es una caída, es una tendencia. |

**Limitación actual:** Terraform implementa umbrales fijos (una sola ventana), no pares multi-ventana completos. La tabla indica qué alarma representa cada nivel; la evaluación exacta de burn rate se hace con Metrics Insights/consulta manual en el dashboard. Endurecerlo a pares 1h/5m y 6h/30m con `evaluation_periods` + `datapoints_to_alarm` es el siguiente paso (ver "Pendiente").

### Alarma de página vs ticket

- **Page (despierta a on-call):** pérdida de disponibilidad, 5xx sistémico, latencia que agota budget rápido, RDS sin espacio. Requiere acción humana inmediata y se enruta al webhook de PagerDuty/Opsgenie (`alert_webhook_url`).
- **Ticket (horario laboral):** tendencia de CPU, WAF bloqueando tráfico, backlog de cola no crítico, presupuesto. Se atiende en el siguiente bloque de trabajo; no justifica interrumpir la noche.
- **Informativo:** `ok_actions` vuelve a notificar el cierre; sirve para confirmar recuperación, no para abrir incidente.

Todas las alarmas publican al mismo topic SNS (`alerts`). La clasificación page/ticket es operativa: el relay de PagerDuty/Opsgenie filtra por `alarm_name` (o por la severidad documentada en `docs/runbooks/alert.md`). Si se necesita separación dura, el siguiente paso es un topic `alerts-page` y otro `alerts-ticket` (no implementado para no duplicar la infraestructura actual).

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

| Métrica                           | Tipo                         | Labels                | Origen                |
| --------------------------------- | ---------------------------- | --------------------- | --------------------- |
| `http_request_duration_ms_bucket` | Histogram                    | `method,route,status` | `metrics.js:20`       |
| `http_requests_total`             | Counter                      | `method,route,status` | `metrics.js:30`       |
| `http_active_requests`            | Gauge                        | —                     | `metrics.js:36`       |
| `erp_http_latency`                | EMF `HttpLatency`            | `ServiceName,Route`   | EMF log `_aws`        |
| `erp_http_5xx`                    | Metric filter `Http5xxCount` | —                     | `observability.tf:80` |

**Prometheus scrape (opcional local):**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'erp'
    static_configs:
      - targets: ['localhost:3001', 'localhost:3002', 'localhost:3003']
    metrics_path: /metrics
```

**EMF — CloudWatch Metrics via Logs:**

Cada `http_request` loggea además un objeto EMF con `_aws` (`metrics.js:50`):

```json
{
  "_aws": {
    "Timestamp": 1234567890123,
    "CloudWatchMetrics": [
      {
        "Namespace": "erp-pipeline/dev",
        "Dimensions": [["ServiceName", "Route"]],
        "Metrics": [{ "Name": "HttpLatency", "Unit": "Milliseconds" }]
      }
    ]
  },
  "ServiceName": "svc-productos",
  "Route": "/api/v1/productos",
  "HttpLatency": 42
}
```

CloudWatch extrae `HttpLatency` automáticamente sin agente. Ver en **Metrics → erp-pipeline/dev**.

---

## Dashboard — `terraform/dashboard.tf:1`

8 widgets (ver `dashboard.tf`):

1. **ECS CPU/Mem** — `AWS/ECS` `CPUUtilization`/`MemoryUtilization` `ClusterName=erp-pipeline-{env}-cluster` 5m `Average`
2. **ServiceErrorCount** — `${project}/${env}` `Sum` 5m, threshold 10 (rojo)
3. **HttpLatency p95 + 5xx** — EMF `HttpLatency p95` + `Http5xxCount Sum` 5m, annot `500ms`
4. **RDS DBConnections + CPU + free storage** — `AWS/RDS` `DatabaseConnections` `Maximum`, `CPUUtilization` y `FreeStorageSpace` `Minimum` (eje derecho) para `erp-pipeline-{env}-postgres`
5. **Logs — Top 5 errors** — Insights `filter level=error | stats count() by service,message`
6. **Latency percentiles** — `p50/p95/p99` de `HttpLatency`
7. **ECS Running vs Desired** — `AWS/ECS` `RunningTaskCount` vs `DesiredCount` 60s (señal de disponibilidad)
8. **ALB unhealthy + 5xx ratio** — `AWS/ApplicationELB` `UnHealthyHostCount`, `HTTPCode_Target_5XX_Count`/`RequestCount` con metric math; muestra "disabled" si `enable_alb=false`

**Crear/ver:**

```bash
terraform -chdir=terraform init -backend-config=environments/backend-dev.hcl
terraform -chdir=terraform apply -var-file=environments/dev.tfvars  # crea dashboard
aws cloudwatch get-dashboard --dashboard-name erp-pipeline-dev-overview --region us-east-2
# Console: https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#dashboards:name=erp-pipeline-dev-overview
```

**Coste:** $3/mes por dashboard (AWS cobra a partir de 3 widgets). En dev puedes no desplegar si quieres $0, pero Fase 9 lo deja habilitado para demo.

---

## Alarmas — `terraform/observability.tf:1`

| Alarma                      | Métrica / expresión                                                                          | Umbral    | `treat_missing_data` | Tipo            | Condición de creación |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------- | -------------------- | --------------- | --------------------- |
| `ecs-running-tasks-low`     | `IF(RunningTaskCount < DesiredCount, 1, 0)` `Average 60s`, 2 datapoints                      | `>0`      | `breaching`          | **Page (SEV1)** | siempre               |
| `alb-unhealthy-hosts`       | `AWS/ApplicationELB UnHealthyHostCount` `Maximum 60s`, 2 datapoints                          | `>0`      | `breaching`          | **Page (SEV1)** | `enable_alb=true`     |
| `alb-5xx-ratio`             | `IF(RequestCount > 0, 100*HTTPCode_Target_5XX_Count/RequestCount, 0)` `Sum 5m`, 2 datapoints | `>1%`     | `notBreaching`       | **Page (SEV2)** | `enable_alb=true`     |
| `alb-latency-p95`           | `AWS/ApplicationELB TargetResponseTime` `p95 5m`, 2 datapoints                               | `>0.5s`   | `notBreaching`       | **Page (SEV2)** | `enable_alb=true`     |
| `high-error-rate`           | `ServiceErrorCount` `Sum 5m`                                                                 | `>10`     | `notBreaching`       | **Page (SEV2)** | siempre               |
| `high-latency-p95`          | `HttpLatency` `p95 5m`                                                                       | `>500ms`  | `notBreaching`       | Ticket (SEV3)   | siempre               |
| `high-5xx-rate`             | `Http5xxCount` `Sum 5m`                                                                      | `>10`     | `notBreaching`       | Ticket (SEV3)   | siempre               |
| `rds-free-storage-low`      | `AWS/RDS FreeStorageSpace` `Minimum 5m`, 2 datapoints                                        | `<10 GiB` | `breaching`          | **Page (SEV2)** | siempre               |
| `rds-cpu-high`              | `AWS/RDS CPUUtilization` `Average 5m`, 3 datapoints                                          | `>80%`    | `notBreaching`       | Ticket (SEV3)   | siempre               |
| `db-connections-high`       | `AWS/RDS DatabaseConnections` `Maximum 5m`                                                   | `>80`     | `notBreaching`       | **Page (SEV2)** | siempre               |
| `waf-blocked-requests-high` | `AWS/WAFV2 BlockedRequests` `Sum 5m` (`Rule=ALL`)                                            | `>1000`   | `notBreaching`       | Ticket (SEV3)   | `enable_waf=true`     |
| `sqs-backlog-high`          | `AWS/SQS ApproximateNumberOfMessagesVisible` `Maximum 5m`                                    | `>10`     | `notBreaching`       | Ticket (SEV3)   | `enable_sqs=true`     |
| `sqs-oldest-message-high`   | `AWS/SQS ApproximateAgeOfOldestMessage` `Maximum 5m`                                         | `>300s`   | `notBreaching`       | Ticket (SEV3)   | `enable_sqs=true`     |
| `sqs-dlq-not-empty`         | `AWS/SQS ApproximateNumberOfMessagesVisible` `Maximum 1m`                                    | `>=1`     | `notBreaching`       | **Page (SEV2)** | `enable_sqs=true`     |

**Por qué `breaching` solo en algunas:** la ausencia de `RunningTaskCount`, `UnHealthyHostCount` o `FreeStorageSpace` significa que el recurso dejó de reportar, y eso ya es una caída (servicio sin tareas, ALB sin targets, RDS parado o inaccesible). En cambio, WAF/SQS/latencia sin tráfico producen silencio normal: marcarlas `breaching` generaría páginas por un entorno idle. `db-connections-high` mantiene `notBreaching` porque un RDS recién reiniciado tarda en publicar.

**SNS:** `aws_sns_topic.alerts` publica a:

- `alert_email` (suscripción email, requiere confirmar el correo tras `apply`);
- `alert_webhook_url` (opcional, HTTPS, `endpoint_auto_confirms=true`) para PagerDuty/Opsgenie o un relay SNS→Slack. Un webhook de Slack "incoming" **no** implementa el handshake de SNS: necesita un relay. Si el endpoint no confirma automáticamente, la suscripción queda `PendingConfirmation` y no llega nada.

Las alarmas SQS/DLQ ya existentes se mantienen y publican al mismo topic; no se duplicaron. La alarma de `DatabaseConnections` también se mantiene sin duplicar.

**Test alarma (<5m):**

```bash
# Genera 11 errores para disparar high-error-rate
for i in {1..11}; do curl -s http://localhost:80/api/v1/productos -H "Content-Type: application/json" -d '{"nombre":"","precio":-1}' >/dev/null; done
# Verifica: debe loggear level=error y metric filter incrementa
aws cloudwatch describe-alarms --alarm-names erp-pipeline-dev-high-error-rate --query 'MetricAlarms[0].StateValue'
# Debe pasar a ALARM en <5m; luego a OK cuando paren errores

# Ver el inventario completo creado por Terraform
terraform -chdir=terraform output -json alarm_names | jq -r '.[]'
```

**Runbook triaje:** ver `docs/runbooks/alert.md:1` — severidades, escalado y pasos por alarma.

### FinOps — budgets y tags

- `terraform/budgets.tf` crea un `aws_budgets_budget` mensual (`COST`, `MONTHLY`) por entorno con `limit_amount = var.monthly_budget_usd`.
- Notificaciones **ACTUAL al 50/80/100%** al mismo topic SNS (`alerts`). AWS Budgets acepta SNS directamente, así que no hace falta el fallback por email.
- El budget se filtra por `TagKeyValue = user:Environment$<env>` para que dev/staging/prod no midan el gasto total de la cuenta. **Requiere activar el cost allocation tag `Environment` una vez** en Billing → Cost allocation tags (o `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Environment,Status=Active`). Sin activarlo, el budget muestra $0 y no alerta.
- `Owner` y `CostCenter` se aplican a todos los recursos vía `default_tags` (`terraform/main.tf`) para chargeback y para que el runbook sepa a quién escalar.
- Presupuestos iniciales: **dev $50**, **staging $150**, **prod $300** (`terraform/environments/*.tfvars`). Ajustar tras el primer mes con datos reales de Cost Explorer.
- La política del topic permite `budgets.amazonaws.com` publicar con condición `aws:SourceAccount`, sin abrir el topic a otras cuentas.

**Verificar:**

```bash
aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --query 'Budgets[].BudgetName'
aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 --granularity MONTHLY \
  --metrics UnblendedCost --group-by Type=TAG,Key=Environment
```

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

| Endpoint              | Qué                                                                                                                          | DB                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /health`         | readiness `SELECT 1` + `latency_ms` + `uptime_s`                                                                             | sí                                               |
| `GET /health/live`    | liveness `uptime_s`                                                                                                          | no                                               |
| `GET /health/ready`   | alias readiness                                                                                                              | sí                                               |
| `GET /health/details` | `status, service, db, latency_ms, uptime_s, memory (rss/heap), pool {totalCount,idleCount,waitingCount}, version, requestId` | sí (pero responde con `pool` incluso si DB down) |
| `GET /metrics`        | Prometheus `http_*`                                                                                                          | no                                               |

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
aws cloudwatch get-dashboard --dashboard-name erp-pipeline-dev-overview --region us-east-2 | jq '.DashboardBody | fromjson | .widgets | length' # debe ser 8

# 5. Alarma <5m
for i in {1..11}; do curl -s -X POST http://localhost:80/api/v1/productos -H "Content-Type: application/json" -d '{"nombre":"","precio":-1}' >/dev/null; done; echo "11 errors sent — espera 5m y revisa SNS / console"
```

## Costes

- Logs retention 7d dev ($0.03/GB) vs 90d prod
- Dashboard $3/mes
- Alarmas $0.10/mes cada una (14 en prod = ~$1.40; dev sin ALB/WAF/SQS = ~$0.70)
- Budgets: $0 (los primeros 2 budgets son gratuitos; el presupuesto de notificaciones es gratuito)
- Tracing si `OTEL_ENABLED=false` $0; si true, OTel collector + X-Ray $5/100k traces (sampling 10% reduce)
- Total Fase 9 + Fase 3A dev: ~$4.50/mes extra (aceptado para observabilidad)

## Pendiente (fuera de Fase 3A)

- **Canary sintético**: un job que ejecute `GET /health` y un CRUD de lectura cada minuto desde fuera de la VPC, publique `SyntheticCanarySuccess` y alerte si falla 2 veces seguidas. Hoy la disponibilidad se infiere del ALB, que no ve una caída de DNS/TLS antes del balanceador.
- **Alarmas multi-ventana completas**: pares 1h/5m (14.4x) y 6h/30m (6x) con `evaluation_periods` + `datapoints_to_alarm` para cada SLO. La tabla de burn rate ya define la política; falta materializarla en Terraform.
- **PagerDuty/Opsgenie real**: `alert_webhook_url` queda vacío hasta que exista el servicio y la rotación on-call. Mientras tanto el canal es email.
- **DR cross-region**: el restore drill valida RTO/RPO en la misma región. Un plan multi-región requiere réplica de lectura RDS, bucket de backups replicado y DNS failover (Route 53).
- **AWS Backup / vault lock**: hoy la recuperación depende de snapshots automáticos de RDS (1 día dev/staging, 7 días prod). Un vault con retención larga e immutabilidad es el siguiente control.
- **Cost Anomaly Detection**: los budgets avisan del gasto acumulado; un detector de anomalías avisa de un pico diario antes de llegar al umbral mensual.

## Referencias

- `packages/shared/src/logger.js:14` + `middleware.js:12` correlation-id
- `packages/shared/src/metrics.js:20` prom-client + EMF
- `terraform/dashboard.tf:1` 8 widgets (incluye ECS tasks y ALB health)
- `terraform/observability.tf:1` alarmas ECS/ALB/RDS/WAF/SQS + 2 metric filters
- `terraform/budgets.tf:1` budget mensual + política SNS para Budgets
- `docs/runbooks/alert.md:1` severidades, escalado y triaje
- `docs/runbooks/restore.md:1` RTO/RPO y restore drill
- `scripts/restore-drill.sh:1` restore automatizado (dry-run por defecto)
- `packages/shared/src/tracing.js:20` OTel SDK
- `services/*/src/routes/health.js:60` details
- `nginx/nginx.conf:45` metrics/health proxy
