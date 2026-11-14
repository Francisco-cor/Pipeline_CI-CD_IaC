# Contributing — ERP Pipeline

> Gracias por querer contribuir. Este repo es un scaffold portfolio con
> estándares production-grade. Las reglas de revisión, ownership y release están
> en [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

## Requisitos

- **Node 24.15+** (`nvm use` lee `.nvmrc`, `asdf install` lee `.tool-versions`).
- Docker Engine + Compose v2.
- Terraform 1.9+ (solo si tocas `terraform/`).
- AWS CLI v2 (solo si tocas infra o deploys manuales).
- Editor con `.editorconfig` + Prettier (`.prettierrc`).

## Setup reproducible

```bash
git clone https://github.com/Francisco-cor/Pipeline_CI-CD_IaC && cd Pipeline_CI-CD_IaC
nvm use                 # o: asdf install
make setup              # npm ci + .env desde .env.example + postgres healthy + migrations
make hooks              # activa .githooks/pre-commit
```

`make setup` no levanta los servicios: deja la base lista para tests. Para el
stack completo con hot-reload usá `make dev`; para el stack prod-like,
`make prod`.

## Flujo local

```bash
# Stack completo (compose + nodemon)
make dev                # Ctrl+C para bajar
make logs               # follow
make down

# Alternativa sin Makefile
./scripts/dev.sh up

# Frontend (dashboard estático)
docker compose --profile frontend up --build
open http://localhost:8080
```

## Verificación antes del PR

```bash
make test-unit          # tests sin DB (shared salvo idempotency + gateway)
make verify-full        # lint + format + compose + terraform + docs-links + tests con DB
```

`make verify-full` levanta `postgres`, aplica migraciones y corre toda la suite.
Si no tenés Docker a mano, el mínimo aceptable es:

```bash
make lint               # eslint --cache en todos los workspaces
make format-check       # prettier --check
make docs-links         # links relativos en .md tracked
make test-unit
```

Comandos sueltos, si necesitás depurar:

```bash
npm ci
npm run lint -- --cache --cache-location .eslintcache
npx prettier --check "services/*/src/**/*.js" "packages/*/src/**/*.js" "migrations/**/*.js"

# Tests con postgres real
docker compose up -d --wait postgres
docker compose run --rm migrations
DATABASE_URL=postgresql://erpadmin:test_password@localhost:5432/erpdb npm test

# e2e (stack completo)
docker compose -f docker-compose.yml up -d --build --wait
bash scripts/e2e.sh
docker compose -f docker-compose.yml down -v
```

## Conventional Commits

El release usa `semantic-release`; el mensaje del commit determina la versión.
Formato:

```
tipo(scope): resumen en imperativo

Cuerpo opcional: por qué, trade-offs, migración/rollback.
```

Tipos permitidos: `feat`, `fix`, `docs`, `ci`, `chore`, `refactor`, `test`,
`perf`, `build`, `style`, `revert`, `infra`, `sec`. El scope es opcional
(`feat(ordenes): ...`). El subject no termina en punto y el header no supera 100
caracteres.

Validación local:

```bash
make commitlint                      # valida HEAD
RANGE=main..HEAD make commitlint     # valida la rama
```

El pre-commit (`.githooks/pre-commit`) corre prettier sobre `.js/.json/.md/.yml`
staged, eslint sobre `.js` staged y `terraform fmt -check` si hay `.tf`. Si falta
una herramienta, avisa y la saltea; si está instalada y falla, bloquea el
commit. Instalación: `make hooks`.

## Ramas y PRs

- Ramas `feat/<scope>`, `fix/<scope>`, `chore/<scope>` desde `main`.
- 1 PR = 1 scope. Si el cambio toca varias fases, dividilo.
- El PR usa `.github/PULL_REQUEST_TEMPLATE.md` con el Definition of Done:
  tests/cobertura, migración/rollback, dashboards/alarmas, seguridad, docs y
  **`CI required` verde**.
- Revisión obligatoria: ver SLA y reglas en `docs/GOVERNANCE.md`.
- Cambios de arquitectura o trade-offs de coste/seguridad requieren un ADR en
  `docs/adr/`.

## Infra (Terraform)

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# editá github_repo y alert_email

./scripts/bootstrap-backend.sh erp-pipeline dev us-east-2
terraform -chdir=terraform init -backend-config=environments/backend-dev.hcl
terraform -chdir=terraform plan -var-file=environments/dev.tfvars
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
```

- Nunca commitear `*.tfstate` ni `*.tfvars` (están en `.gitignore`).
- Cambios de infra → ADR si hay trade-off económico o de seguridad.
- El pipeline corre `fmt/validate/tflint/checkov` en PRs **sin credenciales
  AWS**; el plan remoto se pide desde el workflow confiable.

## Seguridad

- No agregues secretos en código, `.env` ni logs. En AWS usá SSM
  `SecureString` (`/erp/*`, `terraform/modules/secrets/main.tf`).
- CI usa OIDC (`terraform/bootstrap/cicd.tf`, ADR-002). No crees IAM users con
  keys.
- Auth/RBAC/audit: `packages/shared/src/auth.js`,
  `migrations/sql/011_audit_log.sql`. Diagnósticos apagados en prod
  (`ENABLE_DIAGNOSTICS=false`).
- Vulnerabilidades: reporte privado por GitHub Security Advisories, no issues
  públicos. Ver [`SECURITY.md`](SECURITY.md).
- Modelo de amenazas: [`docs/security/threat-model.md`](docs/security/threat-model.md).
- Rotación de secretos: [`docs/security/rotation.md`](docs/security/rotation.md).

## Tests

- Cada servicio: `jest --forceExit --coverage` con postgres real (service
  container en CI) y umbral de cobertura por servicio
  (`services/*/package.json`). Artefacto `coverage-*`.
- `packages/shared` y `svc-gateway` no requieren DB: `make test-unit` (excluye
  `idempotency.test.js`, que usa postgres; esa corre en `make test` y CI).
- e2e: `docker compose -f docker-compose.yml up --build --wait` +
  `scripts/e2e.sh`.
- Si tocás `migrations/sql/*`, la migración debe ser idempotente
  (`IF NOT EXISTS`, checksum en `schema_migrations`) y el job `Migrations` la
  corre dos veces en CI.

## Docs

- Cambios de arquitectura → `docs/ARCHITECTURE.md` + ADR.
- Cambios de API → `docs/openapi.yaml` + ejemplos en `docs/api.md`.
- `make docs-links` valida links relativos; corre en CI como job `Docs links`.
- `docs/interview.md`, `docs/demo.md` y `docs/screenshots/` son material de
  portfolio, no documentación operativa.

## Dudas

Abrí un issue con el template correspondiente (`bug_report.yml` /
`feature_request.yml`) o comentá en el PR. El roadmap vive en issues y ADRs, no
en archivos gitignored.
