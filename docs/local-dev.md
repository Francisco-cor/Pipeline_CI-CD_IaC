# Local Dev — Fase 2

> Stack local con `docker compose` + hot-reload + monorepo shared kernel.

## Requisitos

- Node 20 (`.nvmrc:1`, `.tool-versions:1`)
- Docker Engine + compose v2
- `npm install` en root (workspaces)

## Estructura compose

- `docker-compose.yml:8-146` — base prod-like: `postgres:15-alpine` (health `pg_isready`), `migrations` (init, `service_completed_successfully`), `productos:3001`, `ordenes:3002`, `stock:3003`, `nginx:80` (usa `nginx.local.conf:28-30` con DNS `productos:3001` vs ECS `127.0.0.1`).
- `docker-compose.override.yml:12-62` — dev: monta `services/*/src` + `packages/shared/src` en `/app/services/*/src` y `/app/packages/shared/src`, cambia `command: npm run dev` (nodemon), preserva `node_modules` en volumen anónimo.

## Flujo

```bash
cp .env.example .env
npm install
make dev          # o ./scripts/dev.sh up
# editar services/productos/src/routes/productos.js -> nodemon recarga
curl http://localhost:80/api/productos | jq
make logs         # sigue todos
make down
```

## Shared kernel

- `packages/shared/src/logger.js:1` y `db.js:1` unifican 3 duplicados.
- Servicios hacen `require('@erp/shared')` vía re-export en `services/*/src/logger.js:5` y `db.js:3`.
- Dockerfile servicios usa root context (`docker-compose.yml:43-45` `context: . dockerfile: services/.../Dockerfile`) y copia `packages/shared` + `package.json` workspaces, luego `npm ci` en `/app`.

## Makefile vs scripts/dev.sh

- `Makefile:1` — `make dev|prod|down|logs|ps|nuke|lint|format|verify`
- `scripts/dev.sh:1` — wrapper bash equivalente para quien no usa make.

## Volumes

- `pgdata` — persistente postgres; `make nuke` borra.
- `productos_node_modules` etc. — evita pisar `node_modules` del container con host.

## Troubleshooting

Ver tabla en `README.md:160-175` (Quick Start).

## Verificación

```bash
docker compose config -q && echo "compose ok"
npm run lint && npx prettier --check "services/*/src/**/*.js" "packages/*/src/**/*.js"
```
