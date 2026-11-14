# Runbook — Deploy & Promotion (Fase 7.7 + 3B)

> Cómo se despliega una imagen y cómo se promueve dev → staging → prod con
> `deploy.sh`, GitHub Environments y smoke post-deploy.

## Prerrequisitos

- `IMAGE_TAG` existe en ECR (`scripts/build.sh` previo o pipeline `build` verde)
- AWS CLI con `sts:AssumeRoleWithWebIdentity` o perfil con `ecs:*` + `ecr:DescribeImages`
- `ENVIRONMENT` correcto (`dev` / `staging` / `prod` — prod tiene `deletion_protection=true` en `terraform/environments/prod.tfvars:12`)

## Flujo de promoción

```text
push a main
   │
   ├─ build ── trivy-image ── deploy (dev, automático)
   │                              │
   │                              ▼
   │                        deploy-staging  (si ENABLE_PROMOTION == 'true')
   │                              │  environment: staging + reviewers
   │                              │  deploy.sh ENVIRONMENT=staging
   │                              │  scripts/smoke.sh $STAGING_URL
   │                              ▼
   └──────────────────────── deploy-prod     (needs: deploy-staging)
                                  environment: prod + reviewers
                                  deploy.sh ENVIRONMENT=prod
                                  scripts/smoke.sh $PROD_URL
```

| Etapa   | Job              | Gate                                                        | Verificación                     |
| ------- | ---------------- | ----------------------------------------------------------- | -------------------------------- |
| dev     | `deploy`         | push a `main`                                               | `deploy.sh` (digest + rollback)  |
| staging | `deploy-staging` | `vars.ENABLE_PROMOTION == 'true'` + aprobación del entorno  | `deploy.sh` + `scripts/smoke.sh` |
| prod    | `deploy-prod`    | staging OK + `vars.ENABLE_PROMOTION == 'true'` + aprobación | `deploy.sh` + `scripts/smoke.sh` |

Decisiones de gating:

- La promoción está **apagada por defecto**. Sin `ENABLE_PROMOTION=true`,
  `deploy-staging`/`deploy-prod` quedan `skipped` y `ci-required` los acepta
  (un push normal sigue desplegando solo dev). Con la variable en `true`, un
  fallo de staging o de su smoke marca el pipeline en rojo y **prod no corre**
  porque `deploy-prod` tiene `needs: [build, deploy-staging]`.
- `deploy-staging` también espera a `deploy` (dev): no se promueve una imagen
  que dev no pudo levantar.
- `STAGING_URL`/`PROD_URL` son obligatorias cuando la promoción está activa. El
  job falla **antes** de asumir el rol AWS si están vacías; nunca se hace un
  deploy ciego sin smoke.
- `concurrency: deploy-staging` / `deploy-prod` evita promociones solapadas.

## GitHub Environments y aprobaciones

Crear en **Settings → Environments**:

| Environment | Uso               | Configuración recomendada                                                                  |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `dev`       | deploy automático | sin reviewers; opcional `AWS_ROLE_ARN` propio                                              |
| `staging`   | promoción 1       | **Required reviewers** (1+), wait timer opcional, `AWS_ROLE_ARN` propio                    |
| `prod`      | promoción 2       | **Required reviewers** (2 o el equipo on-call), wait timer opcional, `AWS_ROLE_ARN` propio |

`secrets.AWS_ROLE_ARN` se resuelve primero en el environment y cae al secreto
del repositorio si no existe. Para separar privilegios, crear un rol por entorno
(`terraform/bootstrap/cicd.tf` es el punto de partida) y guardarlo como secreto
**del environment**, no del repo. No hace falta inventar secretos nuevos: si no
hay secreto de environment, se usa el rol actual.

Variables (**Settings → Secrets and variables → Actions → Variables**), por repo
o por environment:

| Variable           | Obligatoria | Efecto                                                        |
| ------------------ | ----------- | ------------------------------------------------------------- |
| `ENABLE_PROMOTION` | sí (`true`) | habilita `deploy-staging` y `deploy-prod`                     |
| `STAGING_URL`      | sí          | base URL del smoke de staging (`https://staging.example.com`) |
| `PROD_URL`         | sí          | base URL del smoke de prod (`https://app.example.com`)        |
| `DEV_URL`          | no          | link mostrado en el historial de deployments de dev           |
| `CANARY_URL`       | no          | base URL del workflow externo `canary.yml` (ver más abajo)    |

`deploy-prod` no puede saltar staging: si `deploy-staging` falla, se cancela o
queda rechazado por reviewers, prod no arranca.

## Smoke post-deploy

`scripts/smoke.sh <base_url>` es **read-only** (no crea productos ni órdenes) y
se ejecuta al final de staging y prod:

- `/health` (nginx) con reintentos (por defecto 6 intentos cada 5 s)
- `/api/v1/productos/health`, `/api/v1/ordenes/health`, `/api/v1/stock/health`
- `GET /api/v1/{productos,ordenes,stock}?limit=1` con body JSON válido
- `GET /api/v1/bff/ordenes/<id>?include=producto` **solo si** ya existe una
  orden; con entorno vacío se saltea con warning (no bloquea la promoción)

Variables: `SMOKE_RETRIES`, `SMOKE_DELAY_SECONDS`, `SMOKE_TIMEOUT_SECONDS`.
Cualquier timeout, non-2xx o JSON inválido hace fallar el job y bloquea prod.

```bash
bash scripts/smoke.sh https://staging.example.com
SMOKE_RETRIES=10 bash scripts/smoke.sh "$PROD_URL"
```

El chequeo externo periódico vive en `.github/workflows/canary.yml`: cada 30
minutos hace `curl` a `vars.CANARY_URL` (`/health` + lecturas) y falla si
`CANARY_URL` está vacía. Es barato y no reemplaza CloudWatch Synthetics.

## Deploy via CI/CD (recomendado)

1. Push a `main` → pipeline `build` (`docker/build-push-action@v6`
   `cache-from/to: type=gha`) solo si `dorny/paths-filter` detecta cambios
   (`pipeline.yml` job `changes`)
2. Cada imagen se publica con `:sha-<short>` + `:latest` y attestations
   **SBOM + provenance** (`sbom: true`, `provenance: true`). No se agregan tags
   nuevas.
3. `trivy-image` escanea `CRITICAL,HIGH` y bloquea vulnerabilidades conocidas
4. `deploy` (dev) ejecuta `scripts/deploy.sh`; si `ENABLE_PROMOTION=true`,
   `deploy-staging` repite el mismo `IMAGE_TAG` y `DEPLOY_SERVICES` contra
   staging, corre el smoke, y `deploy-prod` hace lo propio tras la aprobación.

`deploy.sh` usa el mismo tag en los tres entornos; los digests se resuelven
contra ECR dentro del job, así que staging/prod despliegan exactamente las
mismas imágenes que dev.

## Deploy manual (hotfix)

```bash
export AWS_REGION=us-east-2 PROJECT_NAME=erp-pipeline ENVIRONMENT=dev
# 1. Build y push (si no viene de CI)
GIT_SHA=$(git rev-parse --short HEAD) bash scripts/build.sh

# 2. Deploy con lock + verify + digest
IMAGE_TAG=sha-$GIT_SHA bash scripts/deploy.sh
bash scripts/smoke.sh http://<PUBLIC_IP>   # opcional en local

# Salida esperada:
#   [0/3] Verifying images ... OK digest sha256:abc...
#   [1/3] Registered: arn:aws:ecs:...:task-definition/erp-pipeline-dev-app:42
#   [2/3] Updating ECS service...
#   services-stable: OK
#   [3/3] Verifying deployment ... no rollback detected
```

Para staging/prod manual: `ENVIRONMENT=staging|prod IMAGE_TAG=sha-...` (requiere
credenciales con permiso sobre el cluster correspondiente). Preferir el pipeline
para que quede historial y aprobación.

## Qué verifica `deploy.sh`

| Paso            | Check                                                                                                                                               | Fail → acción                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Lock            | `flock /tmp/erp-deploy-<env>.lock` o `mkdir`                                                                                                        | `ERROR another deploy holds lock` → espera o `rm` lock stale          |
| Tag format      | regex `sha-[0-9a-f]{4,40}`                                                                                                                          | WARN pero continúa                                                    |
| ECR verify      | `aws ecr describe-images --image-ids imageTag=$TAG` por cada servicio cambiado (`productos/ordenes/stock/gateway/nginx/migrations`) + `imageDigest` | `MISSING` → aborta, `build.sh` primero                                |
| Register        | `describe-task-definition` → python swap `image` → `register-task-definition`                                                                       | si JSON inválido → `ROLLBACK`                                         |
| Digest verify   | `describe-task-definition $NEW_REVISION` → grep `$TAG`                                                                                              | mismatch → aborta                                                     |
| Update          | `update-service --task-definition $NEW_REVISION`                                                                                                    | si `AccessDenied` → revisa `bootstrap/cicd.tf:118` `ECSServiceDeploy` |
| Wait            | `aws ecs wait services-stable` (10m timeout)                                                                                                        | timeout → `WARN` + sigue a verificar                                  |
| Rollback detect | `describe-services` `taskDefinition` vs `NEW_REVISION` + `events` grep `rollback\|circuit breaker`                                                  | mismatch → `ERROR rollback likely` + exit 1                           |

## Rollback

Ver `docs/runbooks/rollback.md`. Resumen:

1. El **circuit breaker** de ECS revierte solo si la task no pasa health.
2. Rollback manual de imagen: `IMAGE_TAG=sha-<previo> bash scripts/deploy.sh`
   (las últimas `ecr_image_retention_count=5` imágenes siguen en ECR).
3. **Las migraciones no se revierten con la imagen.** El esquema sigue
   adelante; si el bug está en una migración, restaurar/forward-fix según
   `docs/runbooks/rollback.md` + `docs/runbooks/restore.md`.

## Troubleshooting

| Síntoma                          | Causa                                    | Fix                                                                                   |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `MISSING` image                  | `build.sh` no pusheó ese tag             | `bash scripts/build.sh` + verifica `aws ecr describe-images`                          |
| `STAGING_URL is not configured`  | variable ausente con promoción activa    | cargar `vars.STAGING_URL`/`PROD_URL` antes de `ENABLE_PROMOTION=true`                 |
| smoke falla en prod              | health/DB/latencia                       | revisar ECS events + `aws logs tail`; rollback de imagen si es regresión              |
| `another deploy holds lock`      | deploy concurrent (CI + manual)          | `pgrep -af deploy.sh` + `rm /tmp/erp-deploy-<env>.lock` si stale                      |
| `wait services-stable timed out` | health check falla o `startPeriod` corto | `aws ecs describe-services --cluster ... --services ... --query 'services[0].events'` |
| `rollback likely`                | circuito disparado                       | `aws ecs describe-services` + `aws logs tail` + revisar `migrations` exit code        |

## Supply chain

- `docker/build-push-action` publica **SBOM (SPDX)** y **provenance (SLSA)** como
  attestations del índice OCI; no cambian tags ni el flujo de dev.
- ECR mantiene tags mutables (`latest`). El `deploy.sh` ya fija el digest
  `image@sha256:...` en el task definition, así que un `latest` movido no afecta
  un deploy en curso.
- Próximo paso (no implementado): firmar con cosign keyless
  (`sigstore/cosign-installer` pinneado por SHA + `cosign sign --yes <digest>`)
  y verificar en `deploy.sh` con
  `cosign verify --certificate-identity-regexp ... --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
  Requiere una action extra pinneada por SHA; queda documentado, no en el
  pipeline actual.

## Finanzas

- `enable_nat_gateway=false` (default `environments/dev.tfvars:10`) mantiene $0 NAT
- staging/prod con `enable_nat_gateway=true`, `enable_alb=true`, `enable_waf=true` y `enable_service_discovery=true` cuestan NAT ~$32/mes + EIP, ALB, WAF y RDS extra. Validar staging antes del apply productivo.

## Referencias

- `terraform/modules/compute/main.tf:143-200` task def + `templates/taskdef.json.tftpl:1`
- `scripts/deploy.sh:1` hardened flow
- `scripts/smoke.sh:1` smoke read-only
- `docs/runbooks/rollback.md:1` rollback de imagen vs migraciones
- `docs/runbooks/restore.md:1` restore de base
- `docs/data-model.md:1` triggers `updated_at` + stock invariant
