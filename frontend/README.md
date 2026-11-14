# Frontend — ERP Dashboard

Static dashboard que consume `GET /api/v1/{productos,ordenes,stock}` vía NGINX (`http://localhost:80` en compose, `http://<alb-dns>` en prod).

> No requiere build — vanilla HTML/CSS/JS. Sin frameworks, sin CDN, sin
> `unsafe-inline` en el CSP.

## Uso local

```bash
# Opción A: serve local (recomendado)
npx serve frontend -l 8080
# http://localhost:8080 -> API http://localhost:80

# Opción B: docker compose profile frontend
docker compose --profile frontend up --build
# http://localhost:8080

# Opción C: abrir directo (CORS * en dev)
open frontend/index.html  # file:// (usa fetch a http://localhost:80)
```

## Env

- `API_BASE` en `app.js` default `http://localhost:80` (local) — override via
  `?api=http://<alb-dns>` o `localStorage.setItem('api_base', ...)`.
- Solo se aceptan orígenes `http(s)` same-host o de la allowlist
  (`window.ERP_API_ALLOWLIST`); el valor inválido nunca se persiste.
- Prod: `https://api.erp.example.com` cuando `enable_alb=true` + ACM. Ajustá
  `connect-src` en `nginx.conf` a ese origen y quitá `http://localhost:*`.

## Features

- Health live/ready/details + pool stats.
- Productos list con `X-Cache HIT/MISS`, paginación `X-Total-Count`, create.
- Ordenes list + create + `GET /ordenes/:id?include=producto` BFF aggregation.
- Stock movimientos + `POST entrada/salida` 409 handling.
- Metrics link `/metrics` + tracing header `X-Request-Id`.
- Auto-refresh 10s **pausado con `visibilitychange`** cuando la pestaña está
  oculta; se reanuda y refresca al volver.

## Accesibilidad (WCAG 2.1 AA — objetivo mínimo)

- `<html lang="es">`, landmarks (`header`, `main`), headings jerárquicos.
- Cada control tiene `<label for="…">`; los visualmente ocultos usan
  `.sr-only` (no `display:none`).
- Tablas con `<caption class="sr-only">` y `<th scope="col">`.
- Toast con `role="status"`, `aria-live="polite"` y `aria-atomic="true"`;
  `#health` y `#prodCache` también anuncian cambios.
- Foco visible con `:focus-visible` (outline de 3px, offset 2px) en enlaces,
  botones, inputs y selects.
- El detalle de `health/details` se muestra en un `<pre aria-live>`; no se usa
  `alert()` ni handlers inline (`onclick=`, `onsubmit=`).
- Enlaces externos con `rel="noopener noreferrer"`.
- `prefers-reduced-motion` desactiva animaciones/transiciones.
- Contraste de texto ≥ 4.5:1 (`--muted #9aa0b2` sobre `--card #171a23`).

Verificación manual (no hay Lighthouse CI: requeriría una action nueva pinneada
por SHA):

1. `npx serve frontend -l 8080` y abrir Chrome DevTools → Lighthouse (Accessibility)
   y axe DevTools. Objetivo: **0 violations critical/serious**.
2. Navegar solo con teclado (`Tab`, `Shift+Tab`, `Enter`, `Espacio`) y confirmar
   que el foco siempre es visible y el orden es lógico.
3. Simular `prefers-reduced-motion: reduce` en DevTools → Rendering.
4. Ocultar la pestaña 15s y confirmar en la pestaña Network que no hay requests
   de health; al volver, se reanuda.

## Presupuesto de performance

| Métrica                                | Presupuesto | Cómo se mide                           |
| -------------------------------------- | ----------- | -------------------------------------- |
| `app.js` (sin minificar)               | ≤ 12 KB     | `wc -c frontend/app.js`                |
| `styles.css` (sin minificar)           | ≤ 8 KB      | `wc -c frontend/styles.css`            |
| Transferencia de la página (gzip)      | ≤ 100 KB    | DevTools → Network, sin respuestas API |
| LCP (local, API healthy)               | ≤ 2.5 s     | Lighthouse → Performance               |
| CLS                                    | ≤ 0.1       | Lighthouse → Performance               |
| Requests de polling con pestaña oculta | 0           | DevTools → Network                     |
| Long tasks en carga                    | ≤ 50 ms     | DevTools → Performance                 |

`nginx.conf` habilita `gzip` para CSS/JS/JSON y mantiene `server_tokens off`,
CSP estricta (`script-src 'self'`, `script-src-attr 'none'`, `style-src 'self'`)
y `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`.

## Estructura

```
frontend/
├── index.html   # layout + labels + landmarks
├── app.js       # fetch, render, a11y y polling con visibilitychange
├── styles.css   # layout responsive + foco visible + sr-only
├── nginx.conf   # headers/CSP/gzip del contenedor estático
└── Dockerfile   # nginx:alpine serve static (port 8080)
```

Ver `docs/demo.md` para el guion de demo y `docs/interview.md` para las
preguntas de entrevista. Ambos son material de portfolio (no documentación
operativa).
