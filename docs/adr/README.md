# ADRs — Architecture Decision Records

> Decisiones con trade-off que afectan coste, seguridad o evolución. Formato ligero (Status/Context/Decision/Consequences/Alternatives).

## Índice

| ID | Título | Estado | Fecha |
|---|---|---|---|
| [ADR-001](ADR-001-public-subnets-no-nat-gateway.md) | Public Subnets Without NAT Gateway (FinOps $0) | Accepted | 2026-03-20 |
| [ADR-002](ADR-002-oidc-github-actions.md) | OIDC for GitHub Actions instead of long-lived keys | Accepted | 2026-03-20 |
| ADR-003 | WAF + ALB toggle (cuando `enable_alb=true`) | Proposed (Fase 8) | — |
| ADR-004 | Scaling strategy (sidecar vs ALB, autoscaling) | Proposed (Fase 10) | — |
| ADR-005 | Monorepo + shared kernel (`packages/shared`) | Proposed (Fase 2/3) | — |
| ADR-006 | OpenAPI 3.1 + versionado `/api/v1` | Proposed (Fase 3) | — |

## Cómo proponer un ADR

1. Copia `ADR-00X-template.md` (abajo).
2. Numera incremental, `Status: Proposed`.
3. PR con label `adr`, discute, mergea → `Accepted` o `Superseded`.
4. Si reemplaza uno previo, enlaza `Superseded by ADR-00Y`.

## Template

```markdown
# ADR-00X: Título

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-00Y

## Date
YYYY-MM-DD

## Context
Qué problema, qué fuerzas (coste, seguridad, DX, escala).

## Decision
Qué se hace y qué se deja de hacer. Incluir diagrama si aplica.

## Consequences
Positive / Negative / Trade-offs Accepted

## Alternatives Considered
1. Opción → coste/riesgo → por qué se rechazó
2. ...
## References
- link
```

## Convención

- Ubicación: `docs/adr/ADR-00X-*.md`
- Lenguaje: ES o EN consistente con el ADR previo (001/002 en EN, nuevos en ES OK).
- Cada ADR debe enlazar a código: `terraform/...:line`, `services/...:line`.

