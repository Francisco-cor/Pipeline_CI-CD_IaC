# Runbook — Alert Triage (Fase 9.8)

> Qué hacer cuando una alarma de `observability.tf:49` dispara (<5m). Ver `docs/observability.md:1` y `terraform/dashboard.tf:1`.

## Alarmas

| Alarma | Métrica | Umbral | Causa común |
|---|---|---|---|
| `*-high-error-rate` | `ServiceErrorCount Sum 5m` | `>10` | bug 500, DB down, migración fallida |
| `*-high-latency-p95` | `HttpLatency p95 5m` | `>500ms` | slow query (`log_min_duration 1000` en `database/main.tf:60`), pool exhaustion, falta de índice `pg_trgm` |
| `*-high-5xx-rate` | `Http5xxCount Sum 5m` | `>10` | 5xx por validación no capturada o `pool` timeout |
| `*-db-connections-high` | `AWS/RDS DatabaseConnections Maximum 5m` | `>80` | pool leak (`DB_POOL_MAX=3` × N tasks, t3.micro max 112), `idleTimeout` mal, falta `pool.end()` |

## Flujo de triage (SLO <5m)

### 1. Dashboard (30s)

Abre `https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#dashboards:name=erp-pipeline-{env}-overview`

- ¿Cuál widget está en rojo? (annot `threshold 10` / `500ms`)
- ¿Solo un servicio o todos? (si todos → DB o NGINX; si uno → bug en ese servicio)
- ¿Correlación CPU/Mem vs Latency? (si CPU 90% → escala `desired_count`)

### 2. Logs Insights (1m)

Ve a **Logs → Insights → Log group `/ecs/erp-pipeline-{env}`**

```sql
# Top errores (dashboard widget 5)
fields @timestamp, level, service, message, requestId | filter level="error" | stats count() as c by service, message | sort c desc | limit 5

# Si es high-latency: top lentas con requestId
fields @timestamp, service, ms, status, requestId, path | filter message="http_request" and ms > 500 | sort ms desc | limit 20

# Si es high-5xx: filtra por status
fields @timestamp, service, status, path, requestId, error | filter status >= 500 | sort @timestamp desc | limit 20

# Filtra por requestId para traza completa (logs + metrics + traces)
fields @timestamp, level, service, message, requestId | filter requestId="xxx-yyy-zzz" | sort @timestamp desc
```

Copia un `requestId` de la fila más afectada → úsalo en paso 3.

### 3. Health details + metrics (1m)

```bash
# Desde bastión o via NGINX public IP
IP=$(aws ec2 describe-network-interfaces --network-interface-ids $(aws ecs describe-tasks --cluster erp-pipeline-{env}-cluster --tasks $(aws ecs list-tasks --cluster erp-pipeline-{env}-cluster --query 'taskArns[0]' --output text) --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text) --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

curl -s http://$IP/health/details | jq
curl -s http://$IP/metrics | grep -E "http_request_duration|http_active_requests"
curl -s http://$IP/api/productos/health/details | jq '.pool, .memory, .latency_ms'
```

- `pool.waitingCount >0` → pool exhaustion (DB_POOL_MAX pequeño o leak)
- `memory.heapUsed` cerca de 1GB → OOM, escala `cpu/memory` en `compute/main.tf:148`
- `latency_ms` alto solo en `productos` → revisa `pg_stat_statements` + `log_min_duration_statement 1000` en `database/main.tf:60`

### 4. Traces (si OTEL_ENABLED=true)

Si la alarma es `high-latency-p95`, busca la traza del `requestId` lento:

- Jaeger: `http://jaeger:16686` → Service `svc-productos` → Find Traces → filter `http.status_code=200` + `duration >500ms`
- X-Ray (ADOT): Console X-Ray → Traces → filter `service=svc-productos`

La traza muestra si el cuello es `pg.query` (DB) vs `express` vs `rate-limit`.

### 5. Decisión

| Hallazgo | Acción |
|---|---|
| `level=error` `stock insufficient` + `ServiceErrorCount` | Bug funcional → rollback `IMAGE_TAG=sha-prev bash scripts/deploy.sh` (ver `docs/runbooks/rollback.md:1`) |
| `ms >500` + `pg_stat_statements` top query `SELECT * FROM productos WHERE similarity` | Falta índice `pg_trgm` (`migrations/006_trigram_search.sql:5`) o `N+1` → hotfix índice |
| `DBConnections 85` + `pool.waitingCount 5` | Pool leak → revisa `pool.end()` en `SIGTERM` (`index.js:60`), sube `DB_POOL_MAX` o escala `desired_count` |
| `5xx` + `X-Request-Id` mismo en todos servicios | NGINX `502` upstream no resuelve → `docker compose logs` / `ecs describe-services` events |
| Falso positivo (1 spike) | Silencia 5m y observa `ok_actions` — alarma volverá a `OK` en 5m (`treat_missing_data=notBreaching`) |

### 6. Cierre

- Anota en `docs/runbooks/alert.md` la causa y fix (ej. `p95 por falta de índice trigram`).
- Si fue rollback, abre PR con test que reproduce el 500 antes de re-deploy.
- Si fue infra (DB conns), ajusta `database/main.tf:60` `parameter_group` o `compute/main.tf:110` log retention y `terraform apply -var-file=environments/{env}.tfvars`.

## Silenciar / actualizar umbrales

```bash
# Edita observability.tf: threshold 500 → 800 para dev si es muy ruidoso
# terraform plan -var-file=environments/dev.tfvars | grep high-latency
terraform -chdir=terraform apply -var-file=environments/dev.tfvars
```

## Contacto

- SNS `alerts` → `alert_email` en `environments/*.tfvars` (confirma email tras `apply`)
- Dashboard `erp-pipeline-{env}-overview` link en `terraform output dashboard_name`
