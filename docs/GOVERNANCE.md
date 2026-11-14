# Governance — ERP Pipeline

> Reglas de colaboración para un equipo de 3-5 personas. El objetivo es que un
> cambio no llegue a `main` sin revisión, CI verde y una explicación del riesgo.
> Los artefactos de este documento son **documentales**: nada se aplica
> automáticamente desde el repositorio.

## 1. Branch protection / ruleset

La rama `main` es la única rama de integración y despliegue. Se protege con un
**ruleset de repositorio** (Settings → Rules → Rulesets) con estas reglas:

| Regla                           | Configuración                                          | Por qué                                                    |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Require a pull request          | 1 aprobación, dismiss stale reviews, code-owner review | Evita pushes directos y reviews obsoletas.                 |
| Require status checks           | `CI required` (strict)                                 | Un check único y estable; ver §2.                          |
| Require conversation resolution | activo                                                 | Ningún comentario abierto llega a `main`.                  |
| Block force pushes              | `non_fast_forward`                                     | El historial de `main` es inmutable.                       |
| Require linear history          | activo                                                 | Squash/rebase; sin merges con dos padres.                  |
| Prevent deletion                | `deletion`                                             | `main` no se puede borrar por accidente ni por API.        |
| Merge queue (opcional)          | squash, 1-5 entries                                    | Serializa merges y evita que dos PRs verdes rompan `main`. |

La lista de required checks se reduce a **`CI required`** a propósito: es el job
`ci-required` de `.github/workflows/pipeline.yml`, que agrega todos los jobs con
`if: always()` y falla si alguno quedó `failure` o `cancelled`. Exigir cada job
por separado obliga a actualizar la protección cada vez que se agrega un job
(`docs-links`, `migrations`, `terraform`, etc.).

### Aplicar el ruleset

El artefacto versionado es `.github/rulesets/main.json`. No se aplica desde CI:

```bash
# Crear el ruleset (una vez). Requiere permiso admin sobre el repo.
gh api --method POST \
  repos/Francisco-cor/Pipeline_CI-CD_IaC/rulesets \
  --input .github/rulesets/main.json

# Verificarlo
gh api repos/Francisco-cor/Pipeline_CI-CD_IaC/rulesets

# Actualizar uno existente (reemplazar <id>)
gh api --method PUT \
  repos/Francisco-cor/Pipeline_CI-CD_IaC/rulesets/<id> \
  --input .github/rulesets/main.json
```

`~DEFAULT_BRANCH` hace que el ruleset siga a la rama por defecto aunque cambie de
nombre. El JSON de ejemplo no incluye `bypass_actors`: nadie saltea el ruleset,
ni siquiera el owner. Si en el futuro se necesita un bypass de emergencia, se
documenta acá y se audita.

### Qué NO hace el ruleset

- No reemplaza la revisión humana ni el Definition of Done del PR template.
- No impide que un admin cambie la configuración del repo o de los workflows.
- No protege tags: ver §4.

## 2. El check `CI required`

`ci-required` es el contrato con branch protection:

- Corre con `if: always()` y `needs` de todos los jobs.
- Falla si algún `needs.*.result` es `failure` o `cancelled`.
- `skipped` cuenta como OK (por ejemplo, `terraform` en un PR que solo toca
  docs, o `deploy-staging` con `ENABLE_PROMOTION=false`).
- Se agregó `docs-links` como job liviano (sin DB, sin AWS) para que un link
  relativo roto bloquee el merge; ese job también está en `needs` de
  `ci-required`.

Si agregás un job nuevo, sumalo a `needs` de `ci-required`; si no, no bloquea.

## 3. Revisión y SLA

| Etapa                         | SLA                               |
| ----------------------------- | --------------------------------- |
| Primer review de un PR        | ≤ 1 día hábil                     |
| Re-review tras cambios        | ≤ 1 día hábil                     |
| PR de solo docs/DX            | ≤ 2 días hábiles                  |
| Hotfix de seguridad/incidente | ≤ 4 horas (SEV1) / ≤ 1 día (SEV2) |
| Issue con label `triage`      | ≤ 3 días hábiles                  |

Reglas de review:

- 1 aprobación obligatoria; para `terraform/`, `.github/workflows/` y
  `migrations/` se pide además review de la persona con contexto de infra
  (ver `.github/CODEOWNERS`).
- El autor no aprueba su propio PR.
- Un PR no se mergea con conversaciones abiertas ni con `CI required` en rojo.
- Cambios de arquitectura o trade-offs de coste/seguridad requieren un ADR en
  `docs/adr/` antes del merge.
- Si el PR cambia el contrato de API, actualiza `docs/openapi.yaml` y
  `docs/api.md` en el mismo PR.

## 4. Release y tags

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`,
  `refactor:`, `test:`, `perf:`). El scope es opcional y describe el dominio
  (`feat(ordenes): ...`).
- **semantic-release** corre en `.github/workflows/release.yml` solo cuando
  `CI/CD Pipeline` termina con `conclusion=success` en un push a `main`.
  Calcula la versión semántica y crea el tag `vX.Y.Z` + GitHub Release +
  `CHANGELOG.md`.
- El tag apunta al commit que produjo la imagen; el pipeline imprime el
  `sha-<short>` correspondiente. No se re-taggea ECR en el release.
- Un hotfix se mergea a `main` con un `fix:` y sale como patch; no se crean
  ramas de release.
- Los tags no se borran ni se mueven. Si un release está mal, se publica uno
  nuevo con el fix y se deja el anterior documentado.
- `CHANGELOG.md` es generado: no se edita a mano (prettier lo ignora).

## 5. Ownership

`.github/CODEOWNERS` define el owner por defecto (`@Francisco-cor`) y reglas por
dominio. En un equipo de 3-5 personas el split sugerido es:

| Dominio                  | Paths                                                 | Owner sugerido      |
| ------------------------ | ----------------------------------------------------- | ------------------- |
| Catálogo e inventario    | `services/productos`, `services/stock`, `migrations`  | `@org/erp-catalogo` |
| Pedidos y BFF            | `services/ordenes`, `services/gateway`                | `@org/erp-pedidos`  |
| Plataforma / infra / CI  | `terraform`, `scripts`, `.github/workflows`           | `@org/erp-platform` |
| Frontend / edge          | `frontend`, `nginx`                                   | `@org/erp-frontend` |
| Documentación / política | `docs`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md` | `@org/erp-docs`     |

Los handles de equipo son sugerencias: GitHub ignora silenciosamente un team
que no existe, así que se mantiene `@Francisco-cor` como fallback hasta crear el
equipo en la organización. Ver los comentarios de `.github/CODEOWNERS`.

## 6. Merge queue (opcional)

Cuando el volumen de PRs lo justifique:

1. Crear el ruleset con la regla `merge_queue` (ver el bloque comentado en
   `.github/rulesets/main.json`).
2. En el PR, usar **Merge when ready** en vez de merge directo.
3. La cola agrupa hasta 5 PRs, corre `CI required` sobre el resultado agrupado y
   mergea en orden. Si un PR rompe la cola, se expulsa sin afectar a `main`.

No se activa por defecto: con un solo maintainer agrega latencia sin beneficio.

## 7. Excepciones y emergencias

- Un incidente SEV1 permite mergear con una sola aprobación y `CI required`
  verde; no permite saltear el check.
- Si el pipeline está roto por una causa externa (por ejemplo, GitHub Actions
  caído), se documenta en el PR y se mergea con una aprobación; el siguiente PR
  debe restaurar el verde.
- Cualquier excepción se menciona en el PR y en el postmortem del incidente.

## 8. Artefactos relacionados

- `.github/rulesets/main.json` — ruleset de ejemplo para `main`.
- `.github/CODEOWNERS` — ownership por dominio.
- `.github/PULL_REQUEST_TEMPLATE.md` — Definition of Done.
- `.github/ISSUE_TEMPLATE/` — bug/feature + contact links.
- `SECURITY.md` — reporte privado y SLA de seguridad.
- `docs/security/threat-model.md` — amenazas y riesgo residual.
- `CONTRIBUTING.md` — setup, conventional commits, verificación local.
