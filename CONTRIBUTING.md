# Contributing — ERP Pipeline

> Gracias por querer contribuir. Este repo es un scaffold portfolio con estándares production-grade.

## Requisitos

- **Node 20** (`nvm use` lee `.nvmrc:1`), Docker, Terraform >=1.5, AWS CLI v2 (solo si tocas infra).
- Editor con `.editorconfig:1` + Prettier (`.prettierrc:1`).

## Flujo local (sin AWS)

```bash
nvm use           # o fnm/asdf con .tool-versions:1
npm --workspaces # Fase 2: root workspaces (hoy: por servicio)

# Lint + format (por servicio, hasta Fase 2)
npm run lint --workspace=svc-productos
npm run format:check --workspace=svc-productos

# Tests (requieren postgres — ver docker-compose en Fase 2)
npm test

# Terraform
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
```

> **Fase 2** añadirá `docker compose up --build` y `make dev`. Hoy cada servicio se prueba aislado.

## Convenciones

- **Commits:** `tipo(scope): mensaje` — `feat`, `fix`, `chore`, `docs`, `ci`, `infra`, `sec`, `test`, `refactor`.
- **Ramas:** `feat/<scope>` `fix/<scope>` `chore/<scope>` desde `main`.
- **PRs:** 1 PR = 1 fase o 1 scope, CI debe estar verde (`pipeline.yml:18-235`).
- **Formato:** Prettier + ESLint (`eslint:recommended` + `plugin:import/recommended` en `.eslintrc.js:8`). No commitear sin `npm run lint`.

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

## Tests

- Cada servicio: `jest --forceExit` con postgres real (service container en CI `pipeline.yml:76-89`).
- Añade factory/fixtures si tocas `migrations/sql/*` — migraciones deben ser idempotentes (`IF NOT EXISTS`).

## Docs

- Cambios de arquitectura → actualiza `docs/ARCHITECTURE.md` + ADR.
- Cambios de API → actualiza `docs/openapi.yaml` (Fase 3) y ejemplos `curl` en README.

## Dudas

Abre issue con label `question` o comenta en PR. Para roadmap privado Fase 1-11 ver `PLAN_ELEVACION_11_FASES.md` (gitignored).

