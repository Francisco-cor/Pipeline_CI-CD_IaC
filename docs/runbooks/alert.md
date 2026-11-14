# Runbook — Alert triage e incident response

> Qué hacer cuando una alarma de `terraform/observability.tf` dispara. Para el catálogo de SLIs/SLOs y el error budget ver `docs/observability.md#slis-slos-y-error-budget`.

## 1. Severidades

| Severidad  | Definición                                                                   | Ejemplos de alarma                                                                                   | Respuesta                                          | Canal                            |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| **SEV1**   | Servicio caído o sin capacidad de atender tráfico. Usuarios afectados ahora. | `ecs-running-tasks-low`, `alb-unhealthy-hosts`, `sqs-dlq-not-empty` con impacto en órdenes           | Ack ≤ 5 min, mitigar ≤ 30 min, updates cada 30 min | Page (SNS → `alert_webhook_url`) |
| **SEV2**   | Degradación parcial o riesgo alto de agotar el error budget.                 | `alb-5xx-ratio`, `alb-latency-p95`, `high-error-rate`, `db-connections-high`, `rds-free-storage-low` | Ack ≤ 15 min, mitigar ≤ 2h                         | Page (SNS → webhook)             |
| **SEV3**   | Tendencia o capacidad que no afecta a usuarios todavía.                      | `rds-cpu-high`, `high-latency-p95`, `high-5xx-rate`, `waf-blocked-requests-high`, `sqs-backlog-high` | Ack ≤ 1 día hábil, resolver ≤ 1 semana             | Ticket (email/SNS)               |
| **Info**   | Cierre de alarma (`ok_actions`). No abre incidente.                          | Cualquier `*-ok`                                                                                     | Registrar y cerrar                                 | Email                            |
| **FinOps** | Gasto por encima de lo presupuestado.                                        | Budget 50/80/100%                                                                                    | Revisar en el siguiente ciclo                      | Ticket                           |

Reglas rápidas:

- Si hay **5xx sistémico** o **cero targets sanos**, es SEV1 aunque la alarma diga SEV2.
- Si el impacto es **solo interno** (staging/dev), bajar una severidad.
- Si hay **pérdida de datos** o sospecha de corrupción, SEV1 y no ejecutar ningún restore sin leer `docs/runbooks/restore.md`.

## 2. On-call y escalado

La rotación y los contactos reales viven en el servicio de guardia (PagerDuty/Opsgenie) y en `alert_email`. Este repo **no** guarda teléfonos ni emails personales.

1. **Primario**: confirma la página en el tiempo de la severidad. Si no confirma, el servicio escala al secundario automáticamente.
2. **Secundario**: asume a los 15 min sin ack del primario (SEV1/SEV2).
3. **Escalado técnico**: si a los 30 min (SEV1) o 2h (SEV2) no hay mitigación, involucrar al owner del área (`Owner` tag en los recursos) y al tech lead.
4. **Incident Commander**: en SEV1, una persona coordina, otra investiga y otra comunica. No se hace rollback y diagnóstico por la misma persona.
5. **Comunicación**: estado público cada 30 min en SEV1, cada 2h en SEV2. Usar el canal de incidentes acordado, no el hilo de la alarma.

Runbooks relacionados:

- Deploy y rollback: `docs/runbooks/deploy.md`, `docs/runbooks/rollback.md`
- Drift: `docs/runbooks/drift.md`
- Restore/DR: `docs/runbooks/restore.md`
- Rotación de secretos: `docs/security/rotation.md`

## 3. Primeros 5 minutos (cualquier alarma)

1. **Dashboard** (`erp-pipeline-{env}-overview`): ¿qué widget está en rojo? ¿un servicio o todos?
2. **Logs Insights** (`/ecs/erp-pipeline-{env}`):

   ```sql
   fields @timestamp, level, service, message, requestId, ms, status
   | filter level="error" or status >= 500
   | sort @timestamp desc
   | limit 50
   ```

3. **Estado de la alarma y transiciones**:

   ```bash
   aws cloudwatch describe-alarm-history \
     --alarm-name erp-pipeline-{env}-<alarm-suffix> \
     --history-item-type StateUpdate --max-records 10
   ```

4. **Salud de la app** (desde dentro de la VPC o vía ALB):

   ```bash
   curl -s https://<alb-dns>/health/details | jq
   curl -s https://<alb-dns>/metrics | grep -E "http_request_duration|http_active_requests"
   ```

5. **Decisión**: mitigar (rollback, escalar, failover) o escalar. No dejar una alarma SEV1 sin dueño.

## 4. ECS

**Alarma:** `ecs-running-tasks-low` (`RunningTaskCount < DesiredCount`, 2 datapoints de 60s).

1. Ver eventos y tareas paradas:

   ```bash
   aws ecs describe-services --cluster erp-pipeline-{env}-cluster \
     --services erp-pipeline-{env}-service \
     --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:10]}'

   aws ecs list-tasks --cluster erp-pipeline-{env}-cluster --desired-status STOPPED \
     --query 'taskArns[0:5]' --output text | xargs -r -n1 \
     aws ecs describe-tasks --cluster erp-pipeline-{env}-cluster --tasks
   ```

2. Causas frecuentes y acción:
   - `CannotPullContainerError` → imagen/tag inexistente en ECR o falta `ecr:GetAuthorizationToken`. Verificar `deploy.sh` y el digest.
   - `ResourceInitializationError: unable to pull secrets` → SSM/KMS/rol de ejecución. Revisar `secrets` module y rotación.
   - `STOPPED` con exit code 1/137 → crash al arrancar u OOM. Ver logs del task y memoria.
   - `pendingCount > 0` sin running → subnets/SG/capacidad Fargate o `assign_public_ip` incorrecto.
3. Si el servicio está en rollback automático (circuit breaker), confirmar revisión anterior y no forzar un deploy nuevo hasta estabilizar.
4. Escalar horizontalmente no arregla un crash loop: si el task muere antes de `/health`, el problema es imagen/config, no carga.

## 5. ALB

**Alarmas:** `alb-unhealthy-hosts`, `alb-5xx-ratio`, `alb-latency-p95`.

1. **Unhealthy hosts**:

   ```bash
   TG_ARN=$(aws elbv2 describe-target-groups \
     --names erp-pipeline-{env}-tg \
     --query 'TargetGroups[0].TargetGroupArn' --output text)
   aws elbv2 describe-target-health --target-group-arn "$TG_ARN"
   ```

   Si `HealthCheck` falla con 502/504, revisar NGINX y el puerto 80 del task (SG `app_from_alb`).

2. **5xx ratio**: el metric math usa `HTTPCode_Target_5XX_Count / RequestCount`. Si el ratio sube pero el tráfico es bajo, confirmar que no sean dos requests de un scanner. Si es sistémico:
   - Revisar logs por `status >= 500` y `requestId`.
   - Si el 5xx empezó tras un deploy, rollback (`docs/runbooks/rollback.md`).
   - Si el 5xx viene del target pero la app responde 200 internamente, revisar timeouts del target group y `keepalive` de NGINX.

3. **Latencia p95 > 500ms**: comparar `TargetResponseTime` con `HttpLatency` (EMF). Si ALB es alto y app bajo, el cuello está en la red/NGINX; si ambos suben, revisar RDS (`pg_stat_statements`, `log_min_duration_statement=1000`), pool y CPU.
4. **WAF**: si el 5xx coincide con un pico de `BlockedRequests`, revisar `docs/runbooks/alert.md#8-waf` antes de tocar reglas.

## 6. RDS

**Alarmas:** `rds-free-storage-low`, `rds-cpu-high`, `db-connections-high`.

1. **Storage < 10 GiB**:
   - Identificar la tabla/índice que crece: `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;`
   - Revisar `pg_stat_activity` para transacciones largas que impiden vacuum.
   - Mitigar: `VACUUM (VERBOSE, ANALYZE) <tabla>`, purgar/retencionar datos, o aumentar `allocated_storage` (mutación de infraestructura, coordinar ventana). No borrar la instancia.
2. **CPU > 80%**:
   - Top queries por `pg_stat_statements` (extensión habilitada en el parameter group).
   - Si es un pico de migración/backfill, es esperado; si es sostenido, revisar índices y `N+1`.
   - Si el CPU viene de conexiones ociosas, revisar `DB_POOL_MAX` y `idleTimeout` en los servicios.
3. **DBConnections > 80**:
   - `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;`
   - `pool.waitingCount > 0` en `/health/details` confirma agotamiento.
   - Revisar leaks (`pool.end()` en SIGTERM), bajar `DB_POOL_MAX` o escalar tasks. No aumentar `max_connections` sin memoria disponible.
4. **Failover / instancia caída**: si RDS no publica métricas y la app no conecta, tratar como SEV1. No ejecutar restore sobre la instancia original; seguir `docs/runbooks/restore.md` para crear una instancia scratch.

## 7. SQS

**Alarmas:** `sqs-backlog-high`, `sqs-oldest-message-high`, `sqs-dlq-not-empty` (solo con `enable_sqs=true`).

1. **Backlog / oldest message**: revisar el relay del outbox y el consumidor de stock. No borrar mensajes para "limpiar" la alarma.
   ```bash
   aws sqs get-queue-attributes --queue-url "$(terraform -chdir=terraform output -raw sqs_queue_url)" \
     --attribute-names ApproximateNumberOfMessages ApproximateAgeOfOldestMessage
   ```
2. **DLQ con mensajes**: inspeccionar el payload antes de replay. Corregir el consumidor, validar el evento y recién entonces mover mensajes con `aws sqs start-message-move-task` (requiere `--destination-arn` de la cola origen). Si el mensaje es inválido de forma permanente, documentar y descartar con aprobación.
3. Si el backlog empezó tras un deploy, rollback del consumidor y dejar que el outbox drene.

## 8. WAF

**Alarma:** `waf-blocked-requests-high` (`BlockedRequests > 1000 / 5m`, `Rule=ALL`).

1. Revisar sampled requests en la consola de WAF (Web ACL → Sampled requests) y el `terminatingRuleId`.
2. Si es un ataque automatizado: confirmar que el ALB sigue sano y que el rate limit está haciendo su trabajo. No desactivar la Web ACL.
3. Si es un **falso positivo** (clientes legítimos bloqueados): identificar la regla, crear una exclusión acotada (scope-down statement) y desplegarla con revisión. Nunca poner la regla en `count` de forma permanente sin ticket de seguimiento.
4. Si el bloqueo es masivo y afecta disponibilidad, tratar como SEV2 y coordinar con seguridad.

## 9. Budgets (FinOps)

**Notificación:** 50% (aviso), 80% (ticket), 100% (ticket prioritario).

1. Revisar Cost Explorer agrupado por `Environment` y servicio.
2. Confirmar que el tag `Environment` está activo como cost allocation tag; si no, el budget no refleja el gasto real.
3. Causas típicas: NAT Gateway encendido en dev, RDS multi-AZ, logs de retención larga, tareas ECS escaladas, snapshots huérfanos.
4. No apagar recursos de prod sin aprobación; para dev/staging aplicar el modo FinOps documentado en `docs/adr/ADR-001-public-subnets-no-nat-gateway.md`.

## 10. Cierre

- Registrar en el ticket/incidente: hora de detección, hora de mitigación, causa raíz, acción tomada, enlaces a logs/dashboard.
- Si hubo rollback, abrir PR con un test que reproduzca el fallo antes de redeploy.
- Si fue una alarma ruidosa, ajustar el umbral en `terraform/observability.tf` **y** actualizar este runbook; no silenciar sin cambiar el SLO.
- Si fue un incidente SEV1/SEV2, hacer postmortem sin culpa en ≤ 5 días hábiles y agregar una acción con dueño y fecha.
- Para medir RTO/RPO, ejecutar `bash scripts/restore-drill.sh` y anotar la evidencia en `docs/runbooks/restore.md#8-evidencia`.

## 11. Silenciar y umbrales

```bash
# Ver alarmas y estado actual
aws cloudwatch describe-alarms --alarm-name-prefix erp-pipeline-{env} \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue,reason:StateReason}'

# Ajustar un umbral: editar terraform/observability.tf y aplicar solo el cambio revisado
terraform -chdir=terraform plan -var-file=environments/{env}.tfvars
terraform -chdir=terraform apply -var-file=environments/{env}.tfvars
```

No usar `set-alarm-state` para "silenciar": enmascara el problema y no cambia el SLO. Si una alarma es crónicamente ruidosa, el umbral o el SLI están mal definidos.
