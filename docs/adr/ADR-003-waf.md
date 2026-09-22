# ADR-003: WAF Toggle (cuando `enable_alb=true`)

## Status

Accepted (implemented with the production ALB path)

## Date

2026-09-02

## Context

La arquitectura FinOps usa **NGINX sidecar** sin ALB (`ADR-001`) y `limit_req_zone 30r/s` en `nginx/nginx.conf:14` + `express-rate-limit` en `packages/shared/src/middleware.js:15` (Fase 8.3) como mitigación L7.

Cuando `enable_alb=true`, Terraform usa **private subnets + NAT + ALB + ACM**:

- ALB expone `https://api.erp.example.com` con TLS ACM
- ECS tasks corren en `private_subnet_ids` (`terraform/modules/networking/main.tf:104`) sin IP pública
- NAT Gateway ya existe como toggle `enable_nat_gateway` (`terraform/environments/prod.tfvars` lo activa en producción)

En ese momento, **WAF (AWS WAFv2)** es la capa adecuada para protección L7 centralizada (vs NGINX per-task).

## Decision (Accepted)

- El módulo `terraform/modules/waf` se crea sólo cuando `enable_waf=true`.
- El WAF se asocia al ALB regional (`aws_wafv2_web_acl_association`), no a CloudFront.
- Reglas iniciales (managed):

  | Rule                                   | Vendor | Acción |
  | -------------------------------------- | ------ | ------ |
  | `AWSManagedRulesCommonRuleSet`         | AWS    | Block  |
  | `AWSManagedRulesKnownBadInputsRuleSet` | AWS    | Block  |
  | `AWSManagedRulesSQLiRuleSet`           | AWS    | Block  |
  | `RateLimit 1000/5m per IP`             | Custom | Block  |

- Toggle `var.enable_waf` bool default `false` (dev/staging) → `true` en `prod.tfvars`; Terraform exige WAF cuando el entorno es `prod`.
- Coste WAF: ~$5/mes + $1 por 1M requests — documentado en `docs/adr/ADR-003` y `terraform/environments/prod.tfvars` comentario

## Consequences

### Positive

- Protección centralizada en ALB vs per-task NGINX (menos overhead CPU/mem)
- Reglas OWASP managed por AWS, auto-actualizadas
- Rate limiting L7 a nivel edge (antes de llegar a Fargate) — ahorra coste compute
- `enable_alb=false` (actual) mantiene $0 — WAF no se crea, coste $0 (FinOps)

### Negative

- WAF sólo aplica cuando `enable_alb=true` (requiere `enable_nat_gateway=true` + ALB). En el modo FinOps público permanece deshabilitado.
- Coste adicional $5-10/mes en prod cuando se habilite (vs $0 actual)
- Complejidad: reglas WAF deben testearse en `staging` primero (falsos positivos en `AWSManagedRulesCommonRuleSet` pueden bloquear payloads legítimos `POST /api/productos`)

### Trade-offs Accepted

> Mantenemos WAF deshabilitado (`enable_waf=false`) mientras `enable_alb=false` para preservar FinOps $0. Documentamos la toggle y el coste para que la migración a prod sea un `terraform apply -var-file=environments/prod.tfvars` sin sorpresas.

## Alternatives Considered

### 1. WAF en CloudFront (rejected)

- Requiere CloudFront delante de ALB — añade latencia y coste CF ($0.085/GB) sin beneficio para API privada
- ALB WAF es más simple y directo para API regional

### 2. ModSecurity en NGINX sidecar (rejected)

- NGINX sidecar ya hace `limit_req` pero ModSecurity añade CPU/mem overhead por task (0.5 vCPU compartido ya ajustado)
- WAF managed es más mantenible y no consume Fargate resources

### 3. No WAF (rejected para prod)

- Sin WAF, ALB queda expuesto a OWASP Top 10, SQLi, bad bots
- `helmet`, `rate-limit` y `nginx limit_req` son defensa en profundidad pero no sustituyen WAF edge

## Migration Path (Fase 10)

1. `terraform/environments/prod.tfvars`: `enable_nat_gateway=true`, `enable_alb=true`, `enable_waf=true` y ARN ACM aprobado.
2. Terraform crea private subnets + NAT por AZ, ALB público y el WAF asociado; las tasks mantienen `assign_public_ip=false`.
3. El listener HTTP redirige a HTTPS cuando el certificado ACM está configurado; NGINX sigue siendo el target interno.
4. Validar reglas administradas y rate limit en staging antes de aplicar producción.

## References

- [AWS WAF Pricing](https://aws.amazon.com/waf/pricing/)
- [AWS Managed Rules](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html)
- `terraform/modules/networking/main.tf:104` private subnets + NAT toggle (Fase 7.3)
- `nginx/nginx.conf:14` `limit_req_zone` + `packages/shared/src/middleware.js:15` `express-rate-limit` (Fase 8.3) — defensas actuales
- `docs/adr/ADR-001-public-subnets-no-nat-gateway.md:1` FinOps $0 sin ALB/NAT
- `docs/security/rotation.md:1` rotation runbook
