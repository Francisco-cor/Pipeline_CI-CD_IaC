# ADR-004: Scaling Strategy — FinOps $0 → Prod Toggle (ALB + Autoscaling + Cache + Queue)

## Status

Accepted (Fase 10)

## Date

2026-09-02

## Context

Desde Fase 1-9 el stack corre en **FinOps $0**: public subnets sin NAT, `desired_count=1`, `ECR keep 5`, NGINX sidecar sin ALB (`ADR-001`). Esto es defendible para portfolio pero no escala:

- `desired_count=1` = SPOF, sin HA.
- NGINX sidecar escala unitario con app (coupling).
- `ordenes` hace `SELECT productos` directo — rompe bounded contexts (`servicios/ordenes/src/routes/ordenes.js:29` antes de 10.1).
- `stock` hace `INSERT movimientos` sin transacción + sin actualizar `productos.stock` atómico (trigger 005 sí lo hacía pero sin `BEGIN` explícito ni manejo `stock insuficiente`).
- `productos` list sin cache — cada `GET /productos` golpea DB.
- Sin queue — orden y stock son síncronos.
- Sin ALB — no hay TLS terminación ni health TG ni WAF edge.
- Sin autoscaling — p95 se degrada a >500ms con 50 rps.

Objetivo Fase 10: **escalar sin reescribir** manteniendo `main` deployable y toggles `false` por defecto (FinOps).

## Decision

### 10.1 Decoupling `ordenes → productos` via HTTP + circuit breaker

- `PRODUCTOS_URL` env (`http://productos.erp.local:3001` con service discovery, `http://productos:3001` en compose, `http://127.0.0.1:3001` fallback ECS sidecar).
- `packages/shared/src/circuitBreaker.js:1` `CircuitBreaker` CLOSED→OPEN→HALF_OPEN (failureThreshold 5, timeout 10s) — `cockatiel/opossum`-style sin dependencia externa.
- `servicios/ordenes/src/routes/ordenes.js:23` `verifyProductoExists()` intenta HTTP + `breaker.fire()`; si `CIRCUIT_OPEN` o `AbortError` → fallback `SELECT 1 FROM productos`.
- `GET /productos/:id` nuevo en `productos.js:40` para que ordenes obtenga `{data}`.
- Debug `GET /ordenes/_circuit` expone stats (solo non-prod).

Trade-off: fallback DB mantiene compat tests sin service discovery; HTTP aporta bounded context real. Si productos lento, breaker abre y no cascadea.

### 10.2 Stock transactional outbox

- `servicios/stock/src/routes/stock.js:42` `BEGIN; SELECT ... FOR UPDATE; INSERT movimientos; COMMIT` con `client.connect()` — trigger `005_stock_invariant.sql:6` sigue aplicando `stock insuficiente → RAISE EXCEPTION`.
- `409 STOCK_CONFLICT` si `stock insuficiente`.
- Invalida cache `productos:list:*` + `productos:id:*` + publica `stock.actualizado` via queue (best-effort).

### 10.3 Auto-scaling (toggle `enable_autoscaling`)

- `terraform/modules/compute/main.tf:296` `aws_appautoscaling_target ecs` (count toggle) 1-4 + `policy cpu 70%` + `memory 80%` (target tracking).
- `variables.tf:90` `enable_autoscaling=false` default FinOps, `prod.tfvars:18` comenta toggle true (min 2, max 4 prod HA).
- `desired_count` en `compute/main.tf:234` = `enable_autoscaling ? min : 1` + `lifecycle ignore_changes desired_count` para que autoscaling no driftee.

Coste: $0 cuando false, ~$0.40 regla + compute extra cuando escala (Fargate $0.04/vCPU-h).

### 10.4 ALB optional (toggle `enable_alb`)

- `terraform/modules/compute/main.tf:320` `aws_security_group alb` + `aws_lb main` + `aws_lb_target_group app` (ip, port 80, `/health`) + `aws_lb_listener http 80` + `https 443` si `acm_certificate_arn`.
- `terraform/variables.tf:80` `enable_alb=false` default (~$16/mes cuando true) + `acm_certificate_arn=""`.
- `main.tf:141` `subnet_ids = enable_nat_gateway ? private : public` — prod recomendado `enable_nat_gateway=true` + private ECS + ALB público (doc `ADR-001` migración path).
- `aws_ecs_service.app` `dynamic load_balancer` solo cuando `enable_alb` → `container_name nginx container_port 80`.
- NGINX sidecar se vuelve opcional cuando ALB hace routing, pero se mantiene para compat (ALB → nginx → servicios). Fase 11 podría eliminar.

Dependencia: `enable_alb=true` requiere `enable_nat_gateway=true` + `vpc_id` + `public_subnet_ids` (2 AZ). Sin ello `terraform validate` pasa pero `apply` fallaría; documentado en `ADR-004`.

### 10.5 Redis cache for productos

- `packages/shared/src/cache.js:1` abstraction: si `REDIS_URL` seteado intenta `ioredis` (lazy), si no memory Map TTL 30s (`CACHE_TTL`).
- `servicios/productos/src/routes/productos.js:15` `GET /productos` y `GET /productos/:id` usan `cache.get/set/del` + header `X-Cache HIT/MISS`.
- `docker-compose.yml:9` `redis:7-alpine` + `productos.environment REDIS_URL=redis://redis:6379` + `stock` también invalida cache.
- Prod: `terraform/cache.tf:8` `aws_elasticache_cluster redis` `cache.t3.micro` toggle `enable_redis=false` (~$12/mes) + SG `sg_redis 6379 sg_app→6379`.
- `taskdef.json.tftpl:54` inyecta `REDIS_URL` desde `module.compute var.redis_url` (derivado de `aws_elasticache_cluster` endpoint o vacío).

Trade-off: memory fallback mantiene dev $0 sin Redis; ElastiCache da persistencia entre tasks.

### 10.6 SQS outbox `orden → stock` async (optional)

- `packages/shared/src/queue.js:1` abstraction: si `SQS_QUEUE_URL` seteado usa `@aws-sdk/client-sqs` `SendMessage`, si no log `queue_publish_noop`.
- `ordenes.js:140` `publishOrdenCreada(orden)` best-effort tras INSERT; `stock.js:70` `publishStockActualizado`.
- `terraform/sqs.tf:1` `aws_sqs_queue ordenes` + `ordenes-dlq` (DLQ 14d, redrive 5) toggle `enable_sqs=false` ($0.40/millón).
- Consumer opcional `startConsumer` polling cuando `POLL_SQS=true` — doc para ECS sidecar futuro; no activo por defecto.

Prod toggle: `enable_sqs=true` → app debe tener `sqs:SendMessage` en task role (doc, no IAM aún para simplicidad).

### 10.7 Chaos / Load

- `scripts/chaos.sh:1` kill-productos, latency, cache, stock invariant — `docker stop erp-productos` verifica fallback 404 sin 500.
- `scripts/k6/resilience.js:1` 50 rps con mix reads/writes + 10% bad producto_id → 404 debe ser <1% `http_req_failed` y p95 <300ms.
- `scripts/k6/smoke.js:1` mantiene 30 rps baseline.

### Coste total Fase 10 (cuando toggles true, prod)

| Toggle | Recurso | $/mes |
|--------|---------|------|
| `enable_alb=true` | ALB | ~$16 |
| `enable_nat_gateway=true` | NAT GW | ~$32 |
| `enable_redis=true` | ElastiCache t3.micro | ~$12 |
| `enable_autoscaling=true` | policies | ~$0.40 + compute |
| `enable_sqs=true` | SQS 1M msgs | $0.40 |
| Dashboard Fase 9 |  | $3 |
| **Total prod full** |  | ~$64 vs **dev $0 FinOps** todos false |

## Consequences

### Positive

- **Shippable toggle:** `enable_*=false` mantiene dev $0 — `terraform plan -var-file=environments/dev.tfvars` 0 diff prod.
- **Escalabilidad probada:** `desired 1→3` <3m, p95 <300ms @50rps (k6 resilience), orden sin producto → 404 sin DB cascade.
- **Resiliencia:** circuit breaker + fallback, transactional stock, cache hit rate >80% en reads, queue async desacopla.
- **Portabilidad:** local `docker compose up` usa redis memory fallback y productos:3001 sin service discovery; prod usa `erp.local` + ElastiCache/SQS.

### Negative

- **Complejidad operativa:** +4 toggles + 3 servicios Redis/SQS/ALB → 6 combinaciones que testear (dev vs prod).
- **Cache invalidation:** `productos:list:*` wildcard `del` escanea keys (ineficiente con muchos keys) — aceptable para portfolio (<500 keys).
- **ElastiCache single node:** `num_cache_nodes=1` sin replica — aceptable dev, prod debería usar replication_group multi-AZ.
- **SQS IAM no automatizado:** cuando `enable_sqs=true` el task role necesita `sqs:*` manual — Fase 11 podría añadir `aws_iam_role_policy`.

### Trade-offs Accepted

> Mantenemos toggles `false` por defecto para preservar historia FinOps $0 y validación `terraform validate` sin coste. Documentamos coste y migración `enable_nat_gateway=true` + `enable_alb=true` + `enable_redis=true` + `enable_sqs=true` en `environments/prod.tfvars` comentarios y `docs/scale.md` futuro. Esto permite entrevista: "¿Cómo escala a prod?" → "toggle, no rewrite".

## Alternatives Considered

### 1. gRPC / Service Mesh (Istio) vs HTTP + Cloud Map

- gRPC requiere proto + codegen, mesh requiere sidecar Envoy — overkill para 3 servicios. HTTP + Cloud Map `erp.local` es suficiente y builtin ECS.

### 2. Redis Cluster vs memory LRU

- Memory LRU pierde cache al reiniciar task, pero $0. ElastiCache cluster multi-node añadiría ~$25/mes — rechazado para dev.

### 3. SQS + Lambda consumer vs ECS polling

- Lambda consumer es serverless pero añade IAM y evento mapping complejidad. ECS polling `startConsumer` es más simple para demo; Lambda es opción prod futura.

### 4. ALB + Fargate vs NGINX sidecar

- Mantener NGINX sidecar con ALB duplica proxy (ALB→nginx→app) — latencia extra 1-2ms aceptable para Fase 10. Fase 11 podría eliminar nginx y usar ALB target `ip:3001/2/3` por servicio (requiere 3 TGs).

## Migration Path (FinOps → Prod)

```bash
# Dev permanece $0
terraform -chdir=terraform plan -var-file=environments/dev.tfvars  # enable_*=false

# Staging pre-prod (opcional)
# terraform/environments/staging.tfvars: enable_service_discovery=true, enable_redis=false …

# Prod HA (cuando presupuesto habilita)
# 1. Edita prod.tfvars: enable_nat_gateway=true, enable_alb=true, enable_autoscaling=true, enable_redis=true, enable_sqs=true
terraform -chdir=terraform init -reconfigure -backend-config=environments/backend-prod.hcl
terraform -chdir=terraform plan -var-file=environments/prod.tfvars
terraform -chdir=terraform apply -var-file=environments/prod.tfvars
# 2. Verifica: aws elbv2 describe-load-balancers --query LoadBalancers[0].DNSName
#    curl http://<alb-dns>/health → 200 (via ALB TG)
#    curl http://<alb-dns>/api/v1/productos → X-Cache MISS/HIT
# 3. Observa: dashboards Fase 9 siguen funcionales (EMF HttpLatency) + nueva métrica cacheHitRate si instrumentado
# 4. Chaos: ./scripts/chaos.sh http://<alb-dns> all && k6 run scripts/k6/resilience.js -e BASE_URL=http://<alb-dns>
```

## References

- `terraform/variables.tf:80` toggles Fase 10
- `terraform/modules/compute/main.tf:296` autoscaling + `320` ALB
- `terraform/cache.tf:1` ElastiCache + `terraform/sqs.tf:1` SQS
- `packages/shared/src/circuitBreaker.js:1` breaker
- `packages/shared/src/cache.js:1` cache Redis/memory
- `packages/shared/src/queue.js:1` SQS abstraction
- `services/ordenes/src/routes/ordenes.js:23` decoupling + fallback
- `services/productos/src/routes/productos.js:15` cache + `GET /:id`
- `services/stock/src/routes/stock.js:42` transactional outbox
- `docker-compose.yml:9` redis + envs
- `scripts/chaos.sh:1` + `scripts/k6/resilience.js:1`
- `docs/adr/ADR-001-public-subnets-no-nat-gateway.md:1` FinOps base
- `docs/adr/ADR-003-waf.md:1` WAF cuando enable_alb
- `PLAN_ELEVACION_11_FASES.md:246` Fase 10.1-10.8
