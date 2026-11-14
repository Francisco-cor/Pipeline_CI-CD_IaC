# Security Policy

## Versiones soportadas

Solo la última release `v1.x` publicada en GitHub Releases recibe parches de
seguridad. El proyecto no mantiene ramas LTS: `main` es la única rama soportada
y cada tag `v1.x.y` sale de un pipeline verde.

| Versión         | Soporte             |
| --------------- | ------------------- |
| `v1.x` (latest) | ✅ parches y avisos |
| `v1.x` anterior | ❌ sin soporte      |
| `< 1.0`         | ❌ sin soporte      |

## Cómo reportar una vulnerabilidad

**No abras un issue público, un PR ni un discussion con detalles explotables.**

Usá el canal privado de GitHub:

1. Entrá a <https://github.com/Francisco-cor/Pipeline_CI-CD_IaC/security/advisories/new>.
2. Describí impacto, componente afectado, pasos de reproducción y versión/commit.
3. Si podés, adjuntá un PoC mínimo. No incluyas datos reales de terceros.
4. Si el reporte involucra un secreto que ya está en el historial, **no lo pegues
   completo**: indicá el archivo, commit y tipo de secreto; coordinamos la
   rotación por el advisory.

GitHub Security Advisories permite discutir, asignar CVE y publicar el aviso con
crédito sin exponer el detalle antes del fix.

## SLA de respuesta

| Etapa                                  | Objetivo                          |
| -------------------------------------- | --------------------------------- |
| Acuse de recibo                        | ≤ 3 días hábiles                  |
| Triage inicial (severidad + alcance)   | ≤ 7 días hábiles                  |
| Fix o mitigación para **crítico/alto** | ≤ 30 días desde el triage         |
| Fix o mitigación para **medio/bajo**   | próximo release planificado       |
| Aviso público (advisory)               | coordinado con el fix y el deploy |

La severidad se evalúa con CVSS v3.1 y el impacto real en este despliegue
(por ejemplo, un endpoint de diagnóstico ya apagado en prod baja de severidad).
Si el reporte es un duplicado o no es explotable, lo explicamos igual.

## Alcance

En alcance:

- `services/*` (productos, ordenes, stock, gateway) y `packages/shared`:
  autenticación JWT/RBAC, validación de entrada, inyección SQL, SSRF en el
  circuit breaker HTTP, manejo de errores, audit log.
- `nginx/`, `frontend/`: bypass de proxy, headers/CSP, XSS en el dashboard,
  límites de rate.
- `terraform/` y `.github/workflows/`: IAM/OIDC, secretos en SSM, buckets y
  políticas, supply chain (gitleaks/trivy/SBOM), permisos de workflows.
- `migrations/`: idempotencia, checksums, permisos de DB.
- Dependencias y acciones de GitHub usadas por el pipeline.

Fuera de alcance (pero agradecemos el aviso):

- Vulnerabilidades teóricas sin ruta de explotación en este repo (por ejemplo,
  un CVE en una feature que no está activada por los toggles).
- Ataques de denegación de servicio volumétricos contra AWS (van contra AWS
  Shield/WAF, no contra el código).
- Ingeniería social, phishing o acceso físico.
- Entornos locales del reportante con credenciales propias.

## Qué NO hacer

- ❌ Abrir un issue público con payloads, tokens, capturas de secretos o pasos
  de explotación.
- ❌ Probar en `prod` sin autorización escrita: nada de fuzzing, fuerza bruta,
  extracción de datos ni modificación de recursos reales.
- ❌ Acceder a datos de otros tenants, exfiltrar PII o borrar/alterar registros.
- ❌ Ejecutar `terraform apply/destroy`, `aws` mutante o workflows contra una
  cuenta que no sea la tuya.
- ❌ Publicar el detalle antes de que el advisory esté coordinado.

## Prácticas de seguridad del repositorio

- Auth: JWT (`HS256`/`RS256`) + RBAC `reader`/`operator`/`admin`; ver
  `packages/shared/src/auth.js` y `docs/api.md`.
- Auditoría: toda mutación se registra en `audit_log` (actor, rol, tenant,
  recurso, requestId) — best-effort, nunca tumba la request.
- Secretos: SSM `SecureString` inyectado por ECS; OIDC GitHub→AWS sin claves de
  larga vida. Rotación en `docs/security/rotation.md`.
- Diagnósticos (`/metrics`, `/health/details`, `/_circuit`, `/bff/health`)
  devuelven 404 en prod salvo `ENABLE_DIAGNOSTICS=true`.
- Supply chain: `gitleaks`, `trivy fs/image`, `npm audit --omit=dev`, SBOM y
  provenance en cada imagen; acciones pinneadas por SHA.
- Modelo de amenazas y riesgo residual: `docs/security/threat-model.md`.
- Decisiones de seguridad: `docs/adr/ADR-002-oidc-github-actions.md` y
  `docs/adr/ADR-007-security-model.md`.
