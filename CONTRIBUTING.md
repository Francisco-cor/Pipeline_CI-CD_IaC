# Contributing — ERP Pipeline

> Gracias por querer contribuir. Este repo es un scaffold portfolio con estándares production-grade.

## Requisitos

- **Node 20** (`nvm use` lee `.nvmrc:1`), Docker, Terraform >=1.5, AWS CLI v2 (solo si tocas infra).
- Editor con `.editorconfig:1` + Prettier (`.prettierrc:1`).

## Flujo local (sin AWS) — Fase 6

```bash
nvm use           # o fnm/asdf con .tool-versions:1
npm install       # workspaces: root + services/* + packages/* (Fase 2)

# Lint + format (Fase 6.5: eslint --cache + prettier check)
npm run lint -- --cache --cache-location .eslintcache
npx prettier --check "services/*/src/**/*.js" "packages/*/src/**/*.js" "migrations/**/*.js"
make lint && make format-check

# Tests (requieren postgres — docker compose)
npm test                 # por workspace
docker compose up -d --build --wait && bash scripts/e2e.sh  # e2e (Fase 4.8)
docker compose down -v

# Terraform (Fase 6.4)
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate
tflint --init --chdir=terraform && tflint --recursive --chdir=terraform  # requiere tflint
checkov -d terraform --quiet  # requiere checkov

# Sec (Fase 6.3)
gitleaks detect --source . --verbose
trivy fs --severity HIGH,CRITICAL --ignore-unfixed .

# Verify todo antes de push (Fase 6)
make verify  # lint + format-check + compose config + tf fmt/validate
```

## Convenciones

- **Commits:** `tipo(scope): mensaje` — `feat`, `fix`, `chore`, `docs`, `ci`, `infra`, `sec`, `test`, `refactor`.
- **Ramas:** `feat/<scope>` `fix/<scope>` `chore/<scope>` desde `main`.
- **PRs:** 1 PR = 1 fase o 1 scope, CI debe estar verde (`pipeline.yml:18-711` Fase 6: concurrency + gitleaks/trivy + tflint/checkov + plan comment).
- **Formato:** Prettier + ESLint (`eslint:recommended` + `plugin:import/recommended` en `.eslintrc.js:8`) con `eslint --cache` (`pipeline.yml:130-134`). No commitear sin `npm run lint -- --cache` + `npx prettier --check`.

## Infra (Terraform)

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edita github_repo, alert_email

./scripts/bootstrap-backend.sh erp-pipeline dev us-east-2
terraform -chdir=terraform init -backend-config="bucket=erp-pipeline-tfstate-dev" \
  -backend-config="dynamodb_table=erp-pipeline-tfstate-lock" -backend-config="region=us-east-2"
terraform -chdir=terraform plan
```

- Nunca commitear `*.tfstate`, `*.tfvars` (ya en `.gitignore:4-20`).
- Cambios infra → ADR en `docs/adr/` si hay trade-off económico/de seguridad.

## Seguridad

- No añadir secretos en código/env. Usa SSM Parameter Store (`/erp/...` en `terraform/modules/secrets/main.tf:23`).
- CI usa OIDC (`terraform/cicd.tf:17-65`, ADR-002). No crear IAM users con keys.

## Tests (Fase 4 + 6.6)

- Cada servicio: `jest --forceExit --coverage` con postgres real (service container en CI `pipeline.yml:242-304`), threshold 80% (`services/productos/package.json:44`), artifact `coverage-*`.
- e2e: `docker compose up --build --wait` + `scripts/e2e.sh` (`pipeline.yml:310-339`).
- Añade factory/fixtures si tocas `migrations/sql/*` — migraciones deben ser idempotentes (`IF NOT EXISTS`, `schema_migrations` en `migrations/run.js:14-48` Fase 5).

## Docs

- Cambios de arquitectura → actualiza `docs/ARCHITECTURE.md` + ADR.
- Cambios de API → actualiza `docs/openapi.yaml` (Fase 3) y ejemplos `curl` en README.

## Dudas

Abre issue con label `question` o comenta en PR. Para roadmap privado Fase 1-11 ver `PLAN_ELEVACION_11_FASES.md` (gitignored).
