# ADR-007: Security model — auth, RBAC, audit y fronteras de confianza

## Status

Accepted

## Date

2026-11-13

## Context

El proyecto pasó de un scaffold sin autenticación a un despliegue que maneja
inventario y órdenes reales en AWS. Necesitamos una decisión explícita y
mantenible sobre:

- cómo se autentica y autoriza cada request;
- qué se registra para poder investigar un incidente;
- qué información operativa se expone y dónde;
- qué fronteras de confianza existen y qué riesgo queda abierto.

Sin este ADR, cada servicio podía resolver auth/audit de forma distinta y el
threat model quedaba implícito en el código.

## Decision

### Autenticación y autorización

- **JWT Bearer** en todas las rutas de datos. `HS256` con `JWT_SECRET` o
  `RS256` con `JWT_PUBLIC_KEY`; la clave privada queda en el emisor.
- **RBAC de tres roles**: `reader` (lecturas), `operator` (lecturas + POST/PUT),
  `admin` (todo, incluido DELETE). Se aplica con `authenticate`,
  `requireRole` y `requireScope` en `packages/shared/src/auth.js`.
- `AUTH_ENABLED` es `true` en prod y `false` en dev/test. En prod, un servicio
  sin clave de verificación **no arranca** (`assertAuthConfig`); no se degrada a
  "sin auth".
- `tenant_id` viaja en el JWT y se propaga al audit log. **No hay RLS por
  tenant todavía**; es un gap conocido, documentado en
  `docs/security/rotation.md` §9.

### Auditoría

- Toda mutación (`POST`/`PUT`/`PATCH`/`DELETE`) se registra en `audit_log`
  (`migrations/sql/011_audit_log.sql`) con `actor_sub`, `actor_role`,
  `tenant_id`, `action`, `resource`, `resource_id`, `status`, `request_id` y
  `metadata`.
- El insert es **best-effort**: si falla, se loguea `audit_write_failed` y la
  request original no se altera. `AUDIT_ENABLED=false` desactiva la escritura
  (no recomendado en prod).
- Los efectos asíncronos usan `outbox_events` (publicación) e `inbox_events`
  (deduplicación), no audit de usuario: no hay actor humano en el consumer.

### Diagnósticos y superficie expuesta

- `/metrics`, `/health/details`, `/_circuit` y `/bff/health` son diagnósticos.
  Devuelven **404 en prod** (`ENABLE_DIAGNOSTICS=false`) y NGINX de prod los
  bloquea también en el borde.
- Health público: `/health`, `/health/live`, `/health/ready`. El liveness no
  toca DB; el readiness devuelve 503 durante el draining.
- CORS es una allowlist (`CORS_ORIGIN`); en prod sin allowlist no se emite
  `Access-Control-Allow-Origin` (fail closed).
- Secretos: SSM `SecureString` inyectado por ECS; OIDC GitHub→AWS sin claves de
  larga vida. Rotación en `docs/security/rotation.md`.

### Fronteras de confianza

1. Internet → ALB/WAF → NGINX.
2. NGINX → servicios internos (incluye BFF).
3. Servicios → RDS / SQS / Redis.
4. GitHub Actions → AWS (OIDC).
5. Supply chain de imágenes y dependencias.
6. Frontend (navegador) → API.

Cada frontera tiene un análisis STRIDE con control actual y riesgo residual en
[`docs/security/threat-model.md`](../security/threat-model.md).

## Consequences

**Positivas**

- Un único lugar define auth/RBAC y otro define amenazas; los PRs pueden
  referenciarlos en vez de rediscutirlos.
- El fallo cerrado en prod evita el modo "sin auth" por accidente.
- El audit log permite responder "quién cambió qué" sin depender de logs de
  aplicación.

**Negativas / trade-offs aceptados**

- El audit es best-effort: bajo caída de DB se pierde la traza, no la request.
- Sin RLS, el aislamiento multi-tenant es de aplicación, no de base.
- La rotación de secretos es manual (taint + apply o `ssm put-parameter`).
- Sin firma cosign de imágenes: se verifica digest, no procedencia criptográfica.

**Riesgo residual priorizado**

Ver la tabla final de `docs/security/threat-model.md`. Los pendientes son RLS,
retención inmutable de audit, roles DB least-privilege, rotación automática y
cosign.

## Alternatives Considered

1. **API keys por servicio** → simple, pero sin identidad de usuario, sin roles
   y sin expiración; se descartó porque el audit necesita un actor.
2. **Sesiones con cookies + CSRF** → válido para el dashboard, pero el consumo
   es API-first (curl/k6/BFF) y JWT encaja mejor con el borde NGINX/ALB.
3. **OAuth2/OIDC con un IdP externo (Auth0/Cognito)** → correcto para producto,
   pero agrega coste y un proveedor que el portfolio no necesita; el JWT local
   permite migrar después sin cambiar el contrato (`Authorization: Bearer`).
4. **Deshabilitar auth en prod para simplificar** → rechazado: el threat model
   exige fallo cerrado y el coste de un incidente es mayor.

## References

- `docs/security/threat-model.md` — STRIDE por frontera y riesgo residual.
- `SECURITY.md` — canal de reporte y SLA.
- `docs/security/rotation.md` — rotación de secretos y gaps.
- `docs/adr/ADR-002-oidc-github-actions.md` — OIDC de CI/CD.
- `packages/shared/src/auth.js`, `packages/shared/src/middleware.js`.
- `migrations/sql/011_audit_log.sql`.
- `docs/api.md` — roles, errores y endpoints de diagnóstico.
