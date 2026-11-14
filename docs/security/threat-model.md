# Threat model — ERP Pipeline

> Modelo STRIDE por frontera de confianza. Cada amenaza lista el **control
> actual** (con enlace al código) y el **riesgo residual** que sigue abierto.
> Fecha de revisión: 2026-11-13. Revisar en cada cambio de arquitectura o
> incidente de seguridad.

## Cómo leer este documento

- **Frontera de confianza:** punto donde cambia el nivel de privilegio o el
  origen del dato.
- **Riesgo residual:** lo que queda después de los controles actuales. Si dice
  "aceptado", es una decisión consciente para este alcance de portfolio; si dice
  "pendiente", está en el roadmap de `docs/security/rotation.md` §9.
- Los controles se verifican con `scripts/e2e.sh`, `make verify-full`, tests de
  auth (`services/*/src/__tests__/auth.test.js`) y los gates de CI.

## Activos

| Activo                           | Por qué importa                                                    |
| -------------------------------- | ------------------------------------------------------------------ |
| Datos de productos/stock/ordenes | Integridad del inventario; una escritura indebida rompe el negocio |
| `audit_log`                      | Trazabilidad de mutaciones y responsabilidad (repudio)             |
| `JWT_SECRET` / `JWT_PUBLIC_KEY`  | Emisión y verificación de identidad                                |
| Credenciales RDS/Redis           | Acceso directo a datos y cache                                     |
| Rol OIDC de CI/CD                | Puede desplegar y leer SSM; es el mayor blast radius               |
| Imágenes en ECR                  | Código que corre en producción                                     |
| Secretos en SSM                  | DB URL, JWT, Redis URL                                             |

---

## Frontera 1 — Internet → ALB/WAF → NGINX

Flujo: cliente no autenticado → (ALB + WAF en prod) → NGINX sidecar :80.

| STRIDE                     | Amenaza                                                          | Control actual                                                                                                                                                                                  | Riesgo residual                                                                                                      |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Cliente se hace pasar por otro/renueva IP para evadir rate limit | `real_ip` + `X-Forwarded-For` confiable detrás del ALB, `limit_req_zone 30r/s burst 60` y rate limit de app 100/min (`nginx/nginx.conf`, `packages/shared/src/middleware.js`). TLS/ACM en prod. | Sin ALB (dev) no hay TLS ni WAF; el límite es por proceso, no distribuido. Aceptado en dev.                          |
| **T**ampering              | Modificar request/body para saltar validación                    | Zod en `packages/shared/src/validate.js`, límites de tamaño de body, `helmet`, parseo estricto.                                                                                                 | Reglas de negocio nuevas sin schema quedan abiertas; el PR template exige tests.                                     |
| **R**epudiation            | Cliente niega una mutación                                       | `audit_log` con actor/rol/tenant/acción/recurso/requestId (`011_audit_log.sql`, middleware `auditLog`); `X-Request-Id` en logs.                                                                 | `audit_log` vive en la DB primaria, sin retención WORM; un admin de DB podría alterarlo. Pendiente (rotation.md §9). |
| **I**nformation disclosure | Enumerar endpoints, leer diagnósticos o errores internos         | Diagnósticos 404 en prod (`ENABLE_DIAGNOSTICS=false`) y bloqueados también en NGINX; errores 5xx no exponen `err.message`; `server_tokens off`.                                                 | Un endpoint nuevo que olvide el gate puede filtrar metadata; el threat model se revisa en el PR.                     |
| **D**enial of service      | Flood de requests o payloads grandes                             | Rate limit NGINX + app, timeouts de proxy, WAF rate-based en prod (`terraform/modules/waf`), ECS autoscaling opcional.                                                                          | Ataque volumétrico L3/L4 depende de AWS Shield; sin ALB no hay WAF. Aceptado para dev.                               |
| **E**levation of privilege | Acceder a rutas de datos sin token                               | `AUTH_ENABLED=true` en prod, `authenticate` + `requireRole`/`requireScope` en todas las rutas de datos (`packages/shared/src/auth.js`); falla cerrado si falta clave (`assertAuthConfig`).      | `AUTH_ENABLED=false` en dev/test es deliberado; un deploy con esa variable en prod sería un error de configuración.  |

Enlaces: [ADR-002](../adr/ADR-002-oidc-github-actions.md) (identidad de CI, no de
usuarios), [ADR-003](../adr/ADR-003-waf.md) (WAF), `docs/api.md` (RBAC).

---

## Frontera 2 — NGINX → servicios internos (incluye BFF)

Flujo: NGINX :80 → `productos:3001`, `ordenes:3002`, `stock:3003`,
`gateway:3004`; en ECS comparten network namespace `localhost`/`127.0.0.1`.

| STRIDE                     | Amenaza                                                  | Control actual                                                                                                                                             | Riesgo residual                                                                                                  |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Llamar a un servicio interno saltando NGINX              | En ECS los puertos solo escuchan en la task (awsvpc, sin ALB directo a servicios); SG de app solo acepta el sidecar/ALB. En compose la red es interna.     | Quien comprometa la task puede hablar con `localhost:*`. Aceptado (misma unidad de confianza).                   |
| **T**ampering              | Inyectar headers `X-Request-Id`/`X-Forwarded-For` falsos | Middleware genera `requestId` si falta; `trust proxy` configurable (`TRUST_PROXY=1`); el hop BFF reescribe `X-Forwarded-For` con `$remote_addr`.           | `TRUST_PROXY` mal configurado permitiría spoofear la IP para rate limit. Documentado en `docs/api.md`.           |
| **R**epudiation            | Acción interna sin correlación                           | `requestId` propagado por `AsyncLocalStorage` (`logger.js`) y devuelto en `X-Request-Id`; audit incluye `request_id`.                                      | Sin tracing distribuido siempre activo (`OTEL_ENABLED` es opt-in).                                               |
| **I**nformation disclosure | BFF agrega datos de otro recurso o filtra stack          | `GET /ordenes/:id?include=producto` valida el id y degrada con `warning` si el circuit está abierto; errores centralizados (`errors.js`) sin stack en 5xx. | El BFF no aplica autorización por recurso más allá del rol; no hay ownership por fila. Ver tenant RLS pendiente. |
| **D**enial of service      | Un servicio lento arrastra a los demás                   | `CircuitBreaker` (`CLOSED→OPEN→HALF_OPEN`, threshold 5), `AbortController 2s`, fallback DB en ordenes, health/ready con draining.                          | El fallback DB puede aumentar carga en RDS durante una caída de productos. Aceptado y medido por alarmas.        |
| **E**levation of privilege | Reusar el token de un servicio para llamar a otro        | Los servicios no se autentican entre sí dentro de la task; la autorización es del usuario en el borde. El gateway solo agrega lecturas.                    | Un SSRF en `PRODUCTOS_URL` podría alcanzar metadata de ECS; la URL viene de config, no del usuario.              |

---

## Frontera 3 — Servicios → RDS / SQS / Redis

Flujo: servicios → RDS PostgreSQL 15, SQS (outbox/consumer), Redis (cache).

| STRIDE                     | Amenaza                                            | Control actual                                                                                                                                                                     | Riesgo residual                                                                                                                           |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Conectarse a RDS/Redis haciéndose pasar por la app | SG `sg_db:5432` solo desde `sg_app`; Redis con AUTH + `rediss://`; RDS `force_ssl=1`; credenciales en SSM inyectadas como secretos ECS.                                            | Un compromise de la task obtiene las credenciales en memoria. Aceptado; se mitiga con blast radius de la task.                            |
| **T**ampering              | Modificar stock directamente o saltar el trigger   | `productos.stock` es proyección de `movimientos_stock`; trigger `005_stock_invariant.sql` es el único escritor; `PUT /productos` ignora `stock`; transacción `BEGIN … FOR UPDATE`. | El usuario master de RDS puede saltarse el trigger; los roles least-privilege `erp_app`/`erp_migrator` están pendientes (rotation.md §8). |
| **R**epudiation            | Mutación de datos sin rastro                       | `audit_log` para requests + `outbox_events`/`inbox_events` para efectos asíncronos; `schema_migrations.checksum` para cambios de esquema.                                          | El consumer SQS no genera audit de usuario (no hay actor humano); queda el log estructurado y el inbox.                                   |
| **I**nformation disclosure | Leer datos en tránsito o backups                   | TLS RDS (`rejectUnauthorized:true` + CA bundle en prod), Redis TLS, SQS SSE + política que exige TLS; backups cifrados (`storage_encrypted`).                                      | Performance Insights >7d requiere CMK; sin CMK la retención es limitada.                                                                  |
| **D**enial of service      | Agotar el pool de conexiones o llenar la DLQ       | Pool `max 3` por servicio, `statement_timeout`/`lock_timeout` en migraciones, alarmas de DB connections y SQS/DLQ (`observability.tf`).                                            | Un pico de tráfico puede agotar conexiones antes de que autoscale reaccione; hay alarma, no auto-protección.                              |
| **E**levation of privilege | Inyección SQL o de comandos                        | Queries parametrizadas (`pg`), Zod, sin `eval`, sin shell en runtime; migraciones con advisory lock.                                                                               | Una query nueva concatenada pasaría lint pero el PR review debe detectarla; no hay SAST dedicado.                                         |

Enlaces: `docs/security/rotation.md` §2-§8, `docs/data-model.md`,
`migrations/sql/005_stock_invariant.sql`.

---

## Frontera 4 — GitHub Actions → AWS (OIDC)

Flujo: workflow de `main` → `AssumeRoleWithWebIdentity` → rol IAM → ECR/ECS/SSM.

| STRIDE                     | Amenaza                                                   | Control actual                                                                                                                                                                         | Riesgo residual                                                                                                               |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Un repo/rama ajeno asume el rol                           | OIDC trust `StringLike sub` limitado a `repo:owner/repo:ref:refs/heads/main` (`terraform/bootstrap/cicd.tf`); sin claves de larga vida; thumbprint dinámico.                           | Un push a `main` (o un maintainer comprometido) puede asumir el rol. Branch protection + revisión obligatoria son el control. |
| **T**ampering              | PR malicioso modifica el workflow y exfiltra credenciales | PRs corren sin credenciales AWS (solo checks estáticos); `permissions: contents: read` por defecto; acciones pinneadas por SHA; environments con required reviewers para staging/prod. | Un cambio malicioso en `main` sí tiene credenciales. Requiere review; el threat model no reemplaza el proceso.                |
| **R**epudiation            | No saber qué run desplegó qué imagen                      | `IMAGE_TAG=sha-<short>` + digest en el task definition; deployment history por environment; `release.yml` imprime tag e imagen.                                                        | El historial de environments de GitHub es la fuente de verdad; no se exporta a un sistema inmutable.                          |
| **I**nformation disclosure | Plan de Terraform o logs con secretos                     | `terraform-plan.yml` no sube el `tfplan` (contiene password de RDS); `terraform show` redacta sensibles; `gitleaks` full history.                                                      | Logs de `terraform plan` podrían mostrar valores no marcados `sensitive`; revisar antes de compartir.                         |
| **D**enial of service      | Workflows caros o loops                                   | `concurrency` (cancela PRs), `timeout-minutes`, `paths-filter`, cache de npm/buildx.                                                                                                   | Un workflow manual mal configurado puede consumir minutos. Aceptado.                                                          |
| **E**levation of privilege | Usar el rol de CI para leer SSM o modificar infra         | Políticas IAM acotadas por recurso (SSM ARNs, ECR repos, ECS service); `kms:Decrypt` con `ViaService`; rol separado en `bootstrap/` que sobrevive al teardown.                         | El rol de deploy puede leer los secretos de la app. Es necesario para inyectar `secrets`; se compensa con revisión y OIDC.    |

Enlaces: `docs/adr/ADR-002-oidc-github-actions.md`,
`docs/security/rotation.md` §1, `.github/workflows/pipeline.yml`.

---

## Frontera 5 — Supply chain de imágenes y dependencias

Flujo: base image `node:24-alpine` + `npm ci` + buildx → ECR → ECS.

| STRIDE                     | Amenaza                                     | Control actual                                                                                                                                                      | Riesgo residual                                                                                                                            |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **S**poofing               | Imagen/tag reemplazado por otro contenido   | `deploy.sh` resuelve el **digest** en ECR y verifica que el task definition lo use; tags `sha-*` inmutables en la práctica; SBOM/provenance attestations por build. | No hay firma cosign todavía (documentado en `docs/runbooks/deploy.md` §Supply chain). `latest` es mutable pero no se usa para deploy.      |
| **T**ampering              | Dependencia comprometida o acción maliciosa | `npm ci` con lockfile, `npm audit --omit=dev --audit-level=high`, Dependabot agrupado, acciones pinneadas por SHA, `gitleaks` + `trivy fs/image` como gates.        | Un maintainer de una dependencia puede publicar una versión maliciosa antes de que el advisory exista; el lockfile limita el blast radius. |
| **R**epudiation            | No poder reconstruir qué se desplegó        | `sha-<short>` + digest + SBOM + provenance + CHANGELOG semántico.                                                                                                   | Las attestations viven en ECR; no se verifican automáticamente en el deploy.                                                               |
| **I**nformation disclosure | SBOM/provenance exponen rutas o secretos    | SBOM es inventario de paquetes, no de secretos; `gitleaks` escanea el historial.                                                                                    | —                                                                                                                                          |
| **D**enial of service      | Base image rota o registry caído            | `ecr_image_retention_count=5` para rollback; buildx cache; deploy falla antes de tocar el servicio si falta la imagen (`describe-images`).                          | El rollback depende de que la imagen previa siga en ECR.                                                                                   |
| **E**levation of privilege | Script de build con permisos excesivos      | Build en runner efímero; sin credenciales AWS en PRs; `docker build` con contexto acotado (`.dockerignore`).                                                        | Un Dockerfile malicioso mergeado podría ejecutar en el runner de `main`; requiere review de `services/*`/`packages/*`.                     |

---

## Frontera 6 — Frontend (navegador) → API

Flujo: dashboard estático (`frontend/`) → `fetch` a `API_BASE` (NGINX o ALB).

| STRIDE                     | Amenaza                                          | Control actual                                                                                                                                          | Riesgo residual                                                                                      |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **S**poofing               | `?api=`/localStorage apunta a un origen atacante | `normalizeApiBase` solo acepta `http(s)` same-host o allowlist (`STATIC_API_ALLOWLIST` + `window.ERP_API_ALLOWLIST`); nunca persiste un valor inválido. | La allowlist incluye `localhost` ports de dev; en prod debe restringirse al origen real.             |
| **T**ampering              | XSS que inyecte HTML en tablas/toast             | `escapeHtml` en todos los valores interpolados; sin `innerHTML` con datos sin escapar; CSP `script-src 'self'` en `frontend/nginx.conf`.                | `style-src 'unsafe-inline'` sigue permitido por estilos inline; migrar a `styles.css` para quitarlo. |
| **R**epudiation            | Acción del dashboard sin actor                   | El dashboard no maneja identidad; las mutaciones van con el token que inyecte el operador y quedan en `audit_log` del backend.                          | Sin login en el dashboard: es una herramienta de operador, no un portal de usuarios.                 |
| **I**nformation disclosure | Mostrar errores con detalles internos            | El toast muestra status + body truncado; no hay stack; los diagnósticos están apagados en prod.                                                         | Un body de error puede incluir `requestId`/detalles; no se muestran tokens.                          |
| **D**enial of service      | Polling cada 10s desde muchas pestañas           | Polling se pausa con `visibilitychange` (pestaña oculta); `setInterval` acotado a health.                                                               | Sin backoff si la API falla; el usuario ve errores y puede refrescar.                                |
| **E**levation of privilege | Robo de token desde el navegador                 | El dashboard no almacena JWT; no hay `localStorage` de credenciales.                                                                                    | Si un operador pega un token en devtools, queda en el navegador; fuera del alcance de la app.        |

Enlaces: `frontend/README.md`, `frontend/nginx.conf`, `frontend/app.js`.

---

## Riesgos residuales priorizados

| Riesgo                                              | Estado    | Mitigación / siguiente paso                                                      |
| --------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| Sin aislamiento multi-tenant a nivel DB (RLS)       | Pendiente | `docs/security/rotation.md` §9: columna `tenant_id` + `SET LOCAL app.tenant_id`. |
| `audit_log` sin retención inmutable (WORM)          | Pendiente | Export mensual a S3 Object Lock; ver rotation.md §9.                             |
| Rotación de secretos manual                         | Aceptado  | Runbook `docs/security/rotation.md`; automatizar con Secrets Manager a futuro.   |
| Sin firma/verificación cosign de imágenes           | Pendiente | Documentado en `docs/runbooks/deploy.md`; requiere action pinneada por SHA.      |
| Roles DB `erp_app`/`erp_migrator` no implementados  | Pendiente | rotation.md §8; requiere bootstrap idempotente y rehearsal en staging.           |
| `style-src 'unsafe-inline'` en el CSP del dashboard | Aceptado  | Migrar estilos inline a `styles.css` y quitar el permiso.                        |

## Referencias

- `SECURITY.md` — canal de reporte y SLA.
- `docs/adr/ADR-002-oidc-github-actions.md` — identidad de CI sin claves.
- `docs/adr/ADR-007-security-model.md` — resumen auth/RBAC/audit/diagnostics.
- `docs/security/rotation.md` — rotación de secretos y gaps conocidos.
- `packages/shared/src/auth.js` — RBAC y verificación de JWT.
- `packages/shared/src/middleware.js` — helmet/CORS/rate-limit/request-id.
- `migrations/sql/011_audit_log.sql` — esquema de auditoría.
- `terraform/modules/waf/main.tf` — reglas WAF administradas.
- `terraform/bootstrap/cicd.tf` — trust OIDC least-privilege.
