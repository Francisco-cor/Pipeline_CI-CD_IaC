# SPDX-License-Identifier: MIT
# Makefile — DX local para ERP Pipeline
# Fase 2: agrega atajos para compose, lint, test, format
# Uso: make help

.PHONY: help dev dev-detached prod down logs ps test lint lint-fix format format-check nuke clean verify

# Por defecto muestra ayuda
help:
	@echo "ERP Pipeline — targets:"
	@echo "  make dev            - docker compose up --build (con hot-reload via override)"
	@echo "  make prod           - docker compose -f docker-compose.yml up --build (sin override)"
	@echo "  make down           - docker compose down"
	@echo "  make logs           - docker compose logs -f"
	@echo "  make ps             - docker compose ps"
	@echo "  make test           - npm test en workspaces (requiere postgres — usa compose)"
	@echo "  make lint           - eslint en todos los workspaces"
	@echo "  make lint-fix       - eslint --fix"
	@echo "  make format         - prettier --write"
	@echo "  make format-check   - prettier --check"
	@echo "  make nuke           - down -v --remove-orphans (borra pgdata)"
	@echo "  make verify         - lint + format-check + compose config"

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
	npm run lint --workspaces --if-present
	npm run lint

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
# Infra
# ---------------------------------------------------------------------------
tf-fmt:
	terraform -chdir=terraform fmt -recursive

tf-validate:
	terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate

# ---------------------------------------------------------------------------
# Verify (lo que debe estar verde antes de push)
# ---------------------------------------------------------------------------
verify: lint format-check
	docker compose config -q && echo "compose config: ok"
	terraform -chdir=terraform fmt -check -recursive && echo "terraform fmt: ok" || echo "terraform fmt: run 'make tf-fmt'"
	@echo "verify: ok"
