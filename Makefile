# SPDX-License-Identifier: MIT
# Makefile — DX local para ERP Pipeline
# Fase 2: agrega atajos para compose, lint, test, format
# Uso: make help

.PHONY: help dev dev-detached prod down logs ps test lint lint-fix format format-check nuke clean verify tf-fmt tf-validate tf-lint tf-checkov sec-scan

# Por defecto muestra ayuda
help:
	@echo "ERP Pipeline — targets:"
	@echo "  make dev            - docker compose up --build (con hot-reload via override)"
	@echo "  make prod           - docker compose -f docker-compose.yml up --build (sin override)"
	@echo "  make down           - docker compose down"
	@echo "  make logs           - docker compose logs -f"
	@echo "  make ps             - docker compose ps"
	@echo "  make test           - npm test en workspaces (requiere postgres — usa compose)"
	@echo "  make lint           - eslint --cache en todos los workspaces (Fase 6.5)"
	@echo "  make lint-fix       - eslint --fix"
	@echo "  make format         - prettier --write"
	@echo "  make format-check   - prettier --check (Fase 6.5)"
	@echo "  make tf-validate    - terraform init -backend=false && validate (Fase 6.4)"
	@echo "  make tf-lint        - tflint --init && --recursive (Fase 6.4)"
	@echo "  make tf-checkov     - checkov -d terraform --quiet (Fase 6.4)"
	@echo "  make tf-plan-dev    - terraform plan -var-file=environments/dev.tfvars (Fase 7.1)"
	@echo "  make tf-plan-prod   - terraform plan -var-file=environments/prod.tfvars (Fase 7.1)"
	@echo "  make sec-scan       - gitleaks detect + trivy fs (Fase 6.3)"
	@echo "  make nuke           - down -v --remove-orphans (borra pgdata)"
	@echo "  make verify         - lint + format-check + compose config + tf fmt/validate (Fase 7)"

# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------
dev:
	docker compose up --build

dev-detached:
	docker compose up --build -d

prod:
	docker compose -f docker-compose.yml up --build -d

down:
	docker compose down --remove-orphans

logs:
	docker compose logs -f

ps:
	docker compose ps

nuke:
	docker compose down -v --remove-orphans
	docker volume prune -f

# ---------------------------------------------------------------------------
# Calidad
# ---------------------------------------------------------------------------
lint:
	npm run lint --workspaces --if-present -- --cache --cache-location .eslintcache
	npm run lint -- --cache --cache-location .eslintcache

lint-fix:
	npm run lint:fix --workspaces --if-present
	npm run lint:fix

format:
	npx prettier --write "services/*/src/**/*.js" "packages/*/src/**/*.js" "migrations/**/*.js" "*.js" "*.json" "*.md"

format-check:
	npx prettier --check "services/*/src/**/*.js" "packages/*/src/**/*.js" "migrations/**/*.js" "*.js" "*.json" "*.md"

test:
	npm run test --workspaces --if-present

# ---------------------------------------------------------------------------
# Infra (Fase 6.4 + 7.1)
# ---------------------------------------------------------------------------
tf-fmt:
	terraform -chdir=terraform fmt -recursive

tf-validate:
	terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate

tf-lint:
	tflint --init --chdir=terraform && tflint --recursive --chdir=terraform --format compact

tf-checkov:
	checkov -d terraform --quiet --framework terraform --soft-fail

tf-plan-dev:
	terraform -chdir=terraform init -backend=false -input=false >/dev/null && terraform -chdir=terraform validate >/dev/null && terraform -chdir=terraform plan -var-file=environments/dev.tfvars -no-color | head -n 50

tf-plan-prod:
	terraform -chdir=terraform init -backend=false -input=false >/dev/null && terraform -chdir=terraform validate >/dev/null && terraform -chdir=terraform plan -var-file=environments/prod.tfvars -no-color | head -n 50

# ---------------------------------------------------------------------------
# Sec (Fase 6.3)
# ---------------------------------------------------------------------------
sec-scan:
	gitleaks detect --source . --verbose || true
	trivy fs --severity HIGH,CRITICAL --ignore-unfixed .

# ---------------------------------------------------------------------------
# Verify (lo que debe estar verde antes de push) — Fase 7
# ---------------------------------------------------------------------------
verify: lint format-check
	docker compose config -q && echo "compose config: ok"
	terraform -chdir=terraform fmt -check -recursive && echo "terraform fmt: ok" || (echo "terraform fmt: run 'make tf-fmt'" && exit 1)
	terraform -chdir=terraform init -backend=false -input=false >/dev/null && terraform -chdir=terraform validate -no-color && echo "terraform validate: ok"
	@echo "verify: ok — lint + format + compose + tf fmt/validate (Fase 7) — for full env check: make tf-plan-dev tf-plan-prod"
