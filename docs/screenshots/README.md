# Screenshots — material de portfolio

> Estas imágenes son **capturas reales** del entorno de desarrollo
> (`erp-pipeline-dev`, `enable_alb=false`, FinOps) tomadas durante la
> construcción del proyecto. No son mocks ni renders.
>
> No son documentación operativa: se usan en `README.md`, `docs/demo.md` y el
> portfolio. Si una captura deja de representar el estado actual, se reemplaza o
> se elimina; no se linkea un archivo que no existe.

| Archivo                 | Contenido                                                       |
| ----------------------- | --------------------------------------------------------------- |
| `aws_console.png`       | ECS cluster `erp-pipeline-dev-cluster` con la task y sus contenedores |
| `cloudwatch.png`        | Dashboard de CloudWatch con métricas y log table                |
| `github_actions.png`    | Run verde de `pipeline.yml` en GitHub Actions                   |
| `json_productos_api.png` | `GET /api/v1/productos` con `X-Total-Count` y `Link`            |
| `json_ordenes_api.png`  | `GET /api/v1/ordenes/:id?include=producto` (BFF aggregation)     |

Para regenerarlas, seguí la tabla de `docs/demo.md` y anotá el entorno y la
fecha en el PR que las actualiza.
