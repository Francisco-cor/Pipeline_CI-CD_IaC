# Frontend — ERP Dashboard (Fase 11.2)

Static dashboard que consume `GET /api/v1/{productos,ordenes,stock}` vía NGINX (`http://localhost:80` en compose, `http://<alb-dns>` en prod).

> No requiere build — vanilla HTML/CSS/JS. Alternative `npm run dev` con `serve`.

## Uso local

```bash
# Opción A: abrir directo (CORS * en dev)
open frontend/index.html  # file:// (usa fetch a http://localhost:80)

# Opción B: serve local (recomendado)
npx serve frontend -l 8080
# http://localhost:8080 -> API http://localhost:80

# Opción C: docker compose profile frontend
docker compose --profile frontend up --build
# http://localhost:8080

# Con gateway BFF profile
docker compose --profile gateway --profile frontend up --build
```

## Env

- `API_BASE` en `app.js` default `http://localhost:80` (local) — override via `?api=http://<alb-dns>` o `localStorage.setItem('api_base', ...)`.
- Prod: `https://api.erp.example.com` cuando `enable_alb=true` + ACM.

## Features (portfolio)

- Health live/ready/details + pool stats
- Productos list con `X-Cache HIT/MISS`, paginación `X-Total-Count`, create
- Ordenes list + create + `GET /ordenes/:id?include=producto` BFF aggregation (Fase 11.1)
- Stock movimientos + `POST entrada/salida` 409 handling
- Metrics link `/metrics` + tracing header `X-Request-Id`
- Auto-refresh 10s, toast errors `{code,message}`

## Estructura

```
frontend/
├── index.html  # layout + controls
├── app.js      # fetch wrappers, render
├── styles.css  # minimal responsive
└── Dockerfile  # nginx:alpine serve static (port 8080)
```

Ver `docs/demo.md` y `docs/interview.md:1` para demo 2m.
