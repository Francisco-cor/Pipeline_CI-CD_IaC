# Interview — ERP Pipeline (Fase 11.7)

> 17 preguntas que un reviewer senior haría en 30m. Cada respuesta enlaza a código / ADR / runbook y métrica.
> Usar en portfolio: leer `docs/interview.md` antes de demo `docs/demo.md:1`.

---

## 1. ¿Cómo harías rollback si deploy rompe prod?

**Deploy circuit breaker + `deploy.sh` hardened.**

- `terraform/modules/compute/main.tf:254` `deployment_circuit_breaker { enable=true rollback=true }` + `health_check_grace_period_seconds 120` — ECS detecta task unhealthy post-`migrations SUCCESS` y vuelve al `TaskDef` previo sin script.
- `scripts/deploy.sh:1` Fase 7.7 `flock` + `ecr describe-images` digest verify + `aws ecs register-task-definition` + `aws ecs update-service` + `aws ecs wait services-stable` + rollback detect (compara `failedTasks`). Si `wait` timeout, CI falla y `pipeline.yml:679` `deploy` job marca `failure` → Slack/SNS.
- Manual: `IMAGE_TAG=sha-<prev> ./scripts/deploy.sh prod` o `terraform apply -var-file=environments/prod.tfvars` con `ignore_changes = [task_definition]` (`compute/main.tf:284`) permite rollback sin TF drift.
- Métrica: `ServiceErrorCount>10/5m` alarma `observability.tf:49` → `docs/runbooks/alert.md:1` triage `<5m` → `health/details` pool + `logs Insights` `filter level=error` → rollback si `p95>500ms`.

Ver `docs/runbooks/rollback.md:1` + `docs/runbooks/deploy.md:1`.

---

## 2. ¿Por qué FinOps $0 sin NAT/ALB y cómo migras a prod sin reescribir?

**Toggles, no rewrite.**

- `docs/adr/ADR-001-public-subnets-no-nat-gateway.md:1` + `docs/adr/ADR-004-scaling-strategy.md:1` — `enable_nat_gateway=false`, `enable_alb=false`, `desired_count=1` default FinOps dev `$0` (tabla `README.md:98` ahorro `$48.40/mo`).
- `terraform/variables.tf:80` `enable_alb/autoscaling/redis/sqs` `false` + `main.tf:141` `subnet_ids = enable_nat_gateway ? private : public` + `compute/main.tf:320` `count = enable_alb ? 1 : 0` ALB + TG `ip:80 /health` + `main.tf:296` autoscaling `1-4` CPU 70%.
- Prod toggle: `terraform/environments/prod.tfvars:20` comentar `enable_nat_gateway=true`, `enable_alb=true` (requerido ACM `acm_certificate_arn`), `enable_autoscaling=true` `min 2`, `enable_redis=true` — `terraform apply -var-file=environments/prod.tfvars` crea EIP+NAT+ALB+Redis sin tocar código (`taskdef.json.tftpl:54` envs `REDIS_URL/SQS_QUEUE_URL/PRODUCTOS_URL`).

Coste prod full `~$64/mes` vs dev `$0` — demostrable en `terraform plan`.

---

## 3. ¿Cómo desacoplaste `ordenes → productos` sin `SELECT` directo?

**HTTP + circuit breaker + fallback DB (Fase 10.1).**

- Antes `ordenes.js:29` `SELECT FROM productos` rompía bounded contexts (gap P1-9). Ahora `services/ordenes/src/routes/ordenes.js:23` `PRODUCTOS_URL` (`http://productos.erp.local:3001` con Cloud Map `erp.local` `compute/main.tf:125` o `http://productos:3001` compose) + `packages/shared/src/circuitBreaker.js:1` `CLOSED→OPEN→HALF_OPEN` `failureThreshold 5 timeout 10s` + `fetchProductoHttp` `AbortController 2s` + `X-Request-Id` propagate.
- `verifyProductoExists()` intenta `breaker.fire()`; si `CIRCUIT_OPEN` o `AbortError` → `logger.warn productos_http_fallback_to_db` + `SELECT 1` fallback (resiliencia). Tests sin `PRODUCTOS_URL` siguen DB directo (compat `e2e.sh:70` `404` FK).
- `GET /productos/:id` nuevo `productos.js:72` con `cache` `X-Cache` para que ordenes obtenga `{data}`.

Métrica: `desired p95 <300ms @50rps` (`scripts/k6/resilience.js:1`) orden sin producto → `404` sin cascade a DB `productos`.

---

## 4. ¿Cómo garantizas stock no negativo bajo concurrencia?

**TX + trigger + 409 (Fase 10.2).**

- `services/stock/src/routes/stock.js:42` `client.connect() → BEGIN; SELECT id,stock FROM productos WHERE id=$1 FOR UPDATE; INSERT movimientos; COMMIT` (`catch ROLLBACK`).
- `migrations/sql/005_stock_invariant.sql:6` `CREATE FUNCTION check_and_update_stock() RETURNS TRIGGER` `AFTER INSERT ON movimientos_stock` `current_stock FOR UPDATE` → `entrada +cantidad / salida -cantidad` `IF new_stock<0 RAISE EXCEPTION 'stock insuficiente...'`.
- App mapea `err.message includes 'stock insuficiente'` → `AppError 409 STOCK_CONFLICT` (`stock.js:80`). `409` testeable en `scripts/chaos.sh:77` `stock invariant`.
- Invalida `cache productos:list:*` + `productos:id` + `publishStockActualizado` (`queue.js:1`).

Concurrent `FOR UPDATE` lock fila `productos` evita race.

---

## 5. ¿Para qué Redis y cómo lo hiciste sin coste en dev?

**`ioredis` + memory fallback (Fase 10.5).**

- `packages/shared/src/cache.js:1` `get/set/del/wrap` — si `REDIS_URL` seteado `ioredis` lazy `enableReadyCheck maxRetries 2`, si no `Map` `TTL 30s` (`CACHE_TTL` env) + `size>500` LRU.
- `services/productos/src/routes/productos.js:15` `GET /productos` `productosCacheKey(page,limit,sort)` `cache.get` → `X-Cache HIT` + `X-Total-Count`; `POST/PUT/DELETE` `cache.del productos:list:*` + `productos:id`.
- `docker-compose.yml:42` `redis:7-alpine` healthcheck `redis-cli ping` + `productos/stock.environment REDIS_URL=redis://redis:6379` (`env` `REDIS_URL` local). `terraform/cache.tf:1` `aws_elasticache_cluster redis cache.t3.micro` toggle `enable_redis=false` (`~$12/mes`).
- `taskdef.json.tftpl:54` env `REDIS_URL` desde `module.compute redis_url` (`main.tf:60` `redis_url = enable_redis ? redis://... : ""`).

Hit rate >80% esperado en reads 90% (`scripts/k6/resilience.js:1` mix 90% reads).

---

## 6. ¿Por qué SQS async `orden → stock` y cómo lo simulaste?

**Outbox pattern (Fase 10.6).**

- `packages/shared/src/queue.js:1` `publish(payload)` — si `SQS_QUEUE_URL` seteado `SQSClient region us-east-2` `SendMessageCommand` `MessageAttributes event/service`, si no `logger.info queue_publish_noop`. `publishOrdenCreada(orden)` best-effort tras `INSERT ordenes` (`ordenes.js:144` `.catch(()=>{})`) no bloquea respuesta `201`; `publishStockActualizado` en `stock.js:70`.
- `terraform/sqs.tf:1` `aws_sqs_queue ordenes` + `ordenes-dlq` `redrive_policy maxReceive 5` `visibility 30s` toggle `enable_sqs` (`$0.40/M`) + `aws_sqs_queue_policy`.
- Consumer `startConsumer(handler)` polling `ReceiveMessage Wait 10s` `Max 5` + `DeleteMessage` cuando `POLL_SQS=true` — documentado para ECS sidecar futuro (`frontend/README` no activo por defecto).
- `taskdef.json.tftpl:62` env `SQS_QUEUE_URL`.

Beneficio: `orden.creada` desacopla stock async; sin SQS, log `noop` mantiene `main` verde.

---

## 7. ¿Cómo funciona autoscaling sin ALB?

**Target tracking CPU/memory (Fase 10.3).**

- `terraform/modules/compute/main.tf:296` `aws_appautoscaling_target ecs count enable_autoscaling` `min 1 max 4` (`prod.tfvars:27` `min 2 max 4` HA) + `aws_appautoscaling_policy cpu` `target 70%` `ECSServiceAverageCPUUtilization` `scale_in/out 60s` + `memory 80%`.
- `aws_ecs_service.app desired_count = enable_autoscaling ? min : 1` (`compute/main.tf:234`) + `lifecycle ignore_changes [task_definition, desired_count]` para que ASG no driftee.
- Sin ALB, métrica es CPU/memory (no `ALBRequestCount`); con ALB futuro se añade `policy request 1000`.

Demo: `desired 1→3 escala <3m` (Fase 10 métrica) vía `aws application-autoscaling describe-scaling-activities`.

---

## 8. ¿Qué aporta ALB y por qué no lo usas en dev?

**Prod toggle (Fase 10.4).**

- `terraform/modules/compute/main.tf:320` `aws_security_group alb 80/443` + `aws_lb main` `application` `subnets = public_subnet_ids` `enable_deletion_protection false` + `aws_lb_target_group app ip:80 /health healthy 2 unhealthy 2` + `aws_lb_listener http 80 forward` + `https 443` si `acm_certificate_arn`.
- `aws_ecs_service load_balancer dynamic` solo `enable_alb` → `container_name nginx 80` (`compute/main.tf:241`) + `aws_security_group_rule app_from_alb` `sg_alb → sg_app 80`.
- Dev `enable_alb=false` (FinOps `$16/mes` ahorrado) usa `nginx` sidecar `127.0.0.1:3001` (ADR-001). Prod `enable_alb=true` requiere `enable_nat_gateway=true` + `acm_certificate_arn` (TLS `ELBSecurityPolicy-TLS-1-2`).
- `nginx.conf:102` `location ~ ^/api/v1/bff/ordenes` proxy a `gateway:3004` (Fase 11.1) vs `ordenes` direct.

Beneficio: TLS ACM + health TG + WAF `ADR-003` (`aws_wafv2_web_acl_association` futuro).

---

## 9. ¿Cómo versionas API sin romper clientes?

**OpenAPI + `/api/v1` + legacy `/api` (Fase 3, ADR-006).**

- `docs/openapi.yaml:1` `openapi 3.1.0` `servers http://localhost:80` + `paths /api/productos`, `/api/v1/productos`, `/health/live|ready` + `schemas ProductoInput/OrdenInput/StockInput` + `Error {code,message,details,requestId}` + `parameters Page/Limit/Sort`.
- `services/productos/src/index.js:66` `app.use('/productos') + '/api/productos' + '/api/v1/productos'` (mismo router) + `nginx/nginx.conf:111` `location ~ ^/api/productos(/.*)?$` + `^/api/v1/productos` `proxy_pass http://productos/productos$1` regex `(/.*)?$` evita `/api/productosmalicious`.
- `packages/shared/src/validate.js:8` `zod` `productoSchema` `precio coerce.number finite >=0` + `fix stock ?? 0` (Fase 3.4) vs scaffold `if (!nombre)`.
- `PaginatedProductos` `data/count/total/page/limit` + headers `X-Total-Count` `X-Page` `Link` (`pagination.js`).

Compat: `grep "if (!nombre"` =0, `openapi lint` 0, `frontend/app.js` usa `v1`.

---

## 10. ¿Por qué monorepo `npm workspaces`?

**Shared kernel (Fase 2, ADR-005).**

- `package.json:6` `workspaces ["services/*","migrations","packages/*"]` + `packages/shared/package.json:1` `@erp/shared` `file:` link + `services/productos/package.json:15` `@erp/shared`.
- `packages/shared/src/{logger,db,errors,validate,middleware,metrics,tracing,circuitBreaker,cache,queue}` (Fase 10) importado por `services/*/src/index.js:3` `require('@erp/shared')`.
- `docker-compose.yml:42` `redis` + `services/*/Dockerfile:11` `COPY packages/shared/src` layer cache ~60% `buildx gha` (`pipeline.yml:467`).
- `docker-compose.override.yml:12` monta `packages/shared/src:ro` + `services/*/src:ro` `nodemon` hot-reload sin rebuild `make dev`.

Trade-off: coupling monorepo vs multi-repo — `npm run test --workspaces` + `coverage 80%` mitiga breaking; `turborepo` rechazado para portfolio 3 servicios.

---

## 11. ¿Cómo observas sin `ssh`?

**Logs/metrics/tracing/health (Fase 9).**

- `packages/shared/src/logger.js:14` `AsyncLocalStorage storage + getRequestId/runWithRequestId` + `middleware.js:12` `storage.enterWith({requestId})` (correlation-id) → JSON `requestId` en `http_request` log `services/productos/src/index.js:33` → CloudWatch `/ecs/erp-pipeline-{env}` `retention 7d dev / 90d prod` (`compute/main.tf:110`) + Insights `filter level=error | stats by service` + `filter requestId=xxx` (`docs/observability.md:30`).
- `packages/shared/src/metrics.js:20` `prom-client Registry histogram http_request_duration_ms buckets 5..2500` + `counter http_requests_total` + `gauge activeRequests` + `metricsMiddleware` EMF `_aws HttpLatency` → `GET /metrics` (`services/productos/src/index.js:63` + `nginx.conf:45`) + `dashboard.tf:10` 6 widgets CPU/Mem/Error/Latency p95/5xx + log table `filter level=error`.
- `terraform/observability.tf:49` 4 alarmas `ServiceErrorCount>10/5m`, `p95>500ms`, `5xx>10/5m`, `DBConnections>80` → SNS `alert_email` + `docs/runbooks/alert.md:1` triage `<5m` dashboard→logs→health→traces→rollback.
- `packages/shared/src/tracing.js:20` `NodeSDK auto-instrumentations OTLPTraceExporter http://localhost:4318/v1/traces` `OTEL_ENABLED` `TRACE_SAMPLE_RATIO 0.1` (`services/*/src/index.js:13` `initTracing`) → Jaeger `http://localhost:16686` / X-Ray.
- `services/*/src/routes/health.js:60` `GET /health/details` `pool {totalCount,idleCount,waitingCount}` + `uptime_s` + `memory rss/heap` + `version` + `requestId` + `latency_ms` (`nginx.conf:61` `~ ^/health/(live|ready|details)$`).

---

## 12. ¿Qué es BFF y dónde lo implementaste?

**Fase 11.1 `GET /ordenes/:id?include=producto` + `svc-gateway`.**

- `services/ordenes/src/routes/ordenes.js:152` `GET /:id` → DB `SELECT orden` + `if include=producto` `breaker.fire(producto_id)` → `{ data: orden, producto: {...}, _bff: "aggregated" }` degraded `warning` si `CIRCUIT_OPEN`.
- `services/gateway/src/index.js:1` `svc-gateway` `PORT 3004` `GET /bff/ordenes/:id` agrega `orden` + `producto` via dos `CircuitBreaker` (ordenes/productos URLs) + `GET /bff/health`.
- `nginx/nginx.conf:102` `location ~ ^/api/v1/bff/ordenes/(?<bffid>...)` `proxy_pass http://127.0.0.1:3004/bff/ordenes/$bffid` (ECS) + `nginx.local.conf:88` `gateway:3004` (compose `profile gateway`). `docker-compose.yml:149` `gateway` `profiles ["gateway"]` no arranca por defecto FinOps; `frontend/app.js:84` `bff(id)` llama ambos endpoints.

Spec replica sin reescribir `ordenes` bounded context.

---

## 13. ¿Cómo probarías resiliencia?

**`scripts/chaos.sh` + `k6` (Fase 10.7).**

- `scripts/chaos.sh:1` modes `kill-productos` `docker stop erp-productos` → `ordenes fallback 404` (no 500), `latency` 10 concurrent burst `http_request_duration_ms_bucket`, `cache` `X-Cache MISS→HIT` after `POST`, `stock invariant` `salida 100` con stock 1 → `409`, `circuit` `GET /_circuit` stats.
- `scripts/k6/resilience.js:1` 50 rps `stages 20→50→0` 50s `thresholds http_req_failed<1% p95<300 p99<500` mix 70% `GET productos`, 20% `POST orden` válida, 10% `POST orden 999999` → `404`, 10% `POST stock` `201|409`.
- `scripts/e2e.sh:11` smoke `health` + `productos CRUD` + `FK 404` + `Link header` + `X-Request-Id` + `helmet`.

CI no corre chaos (long), pero `make verify` + `docker compose --wait` + `e2e` cubre.

---

## 14. ¿Cómo garantizas seguridad supply chain?

**Fase 6.3 + 8.7.**

- `pipeline.yml:216` `gitleaks detect` full history + `trivy fs HIGH,CRITICAL SARIF` + `trivy image` post-build soft-fail; `pipeline.yml:180` `npm audit --omit=dev --audit-level=high` + `snyk` soft-fail; `terraform/.tflint.hcl:1` + `checkov` SARIF `0 high` (política `GetParameter + kms:Decrypt` `secrets/main.tf:73`).
- `packages/shared/src/db.js:18` RDS TLS `rejectUnauthorized:true` prod con CA bundle `certs/rds-ca-bundle.pem` `/app/certs` (`migrations/run.js:15`).
- `nginx.conf:36` `add_header X-Content-Type-Options/CSP/HSTS/Permissions-Policy` + `server_tokens off` + `limit_req_zone 30r/s burst 60 429` (`nginx.conf:14`) + `packages/shared/src/middleware.js:20` `helmet/cors/compression/rate-limit 100/min` `trust proxy 1`.

---

## 15. ¿Qué harías con un `terraform plan` drift?

**Runbook `docs/runbooks/drift.md:1`.**

- `terraform -chdir=terraform plan -var-file=environments/dev.tfvars` debe ser 0 diff si `main` verde; drift por `desired_count` ignorado (`compute/main.tf:284` `ignore_changes [task_definition, desired_count]`) + `aws_elasticache` `apply` no driftea.
- Si drift en `rds_endpoint` (rotación password) → `terraform taint random_password` + `apply` + `ssm put-parameter` (`docs/security/rotation.md:40`).
- `teardown.yml:15` prod guard `if: environment != prod` + `confirm=destroy`.

---

## 16. ¿Cómo vendes el proyecto en 2m?

**Demo `docs/demo.md:1` + `frontend/` + `README.md:145` Monitoring + `README.md:160` Scale + `README.md:190` Demo.**

- `git clone && docker compose up --build -d --wait` <180s + `docker compose --profile frontend up` → `http://localhost:8080` dashboard Fase 11.2 muestra health pool, `X-Cache HIT`, BFF `include=producto`.
- Badges `README.md:3` coverage 80% + OpenAPI 3.1 + trivy + prettier + release + demo + pipeline verde `pipeline.yml:38` `<6m` concurrency+cache.
- `docs/screenshots/demo.gif` 800x450 <5MB + `aws_console.png`/`cloudwatch.png` (dashboard 6 widgets) + `openapi.yaml` contract.
- `ADR-001/002/004/005/006` trazabilidad FinOps/Monorepo/OpenAPI/Scale.
- `CHANGELOG.md:1` semver + tags `v1.11.0` + `make verify` verde en máquina limpia (Fase 11.8).

Métrica Fase 11: `make verify` verde + `README` 2m convence senior.

---

## 17. ¿Qué falta para prod real?

**Gap → Fase 11 polish vs prod checklist.**

- **WAF** `ADR-003-waf.md:1` `enable_waf` cuando `enable_alb=true` + `aws_wafv2_web_acl` managed `CommonRuleSet` + `RateLimit 1000/5m` (`~$5/mes`).
- **KMS CMK** para `SecureString` SSM + `kms:Decrypt ViaService ssm` ya en `secrets/main.tf:73` pero sin CMK custom; `terraform/secrets` podría crear `aws_kms_key`.
- **Backup PITR** 7d prod ya (`database/main.tf:107`), pero falta `final_snapshot true` en prod (`variable prod guard` `main.tf:54`).
- **Multi-AZ** `multi_az prod?true:false` ya (`database/main.tf:104`) pero `desired_count 1` → `enable_autoscaling min 2` HA.
- **Secret rotation lambda** `docs/security/rotation.md:40` manual `ssm put-parameter` + `taint random_password`; prod lambda rotation.

Documentado en `PLAN_ELEVACION_11_FASES.md:10` gaps P1/P2 y `docs/interview.md` para entrevista honesta.

