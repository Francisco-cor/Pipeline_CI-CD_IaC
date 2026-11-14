<!--
  Título: tipo(scope): resumen en imperativo (ver CONTRIBUTING.md).
  Un PR = un scope. Si el cambio toca varias fases, dividilo.
-->

## Qué cambia

<!-- 2-5 bullets. Enlazá el issue o el ADR si aplica. -->

-

## Por qué

<!-- Problema, incidente o decisión. Sin esto, el reviewer no puede evaluar el riesgo. -->

## Cómo probarlo

<!-- Comandos reproducibles. Si no corriste nada, decilo explícitamente. -->

```bash

```

## Definition of Done

- [ ] **Tests/cobertura:** agregué o actualicé tests; `npm test` (o `make verify-full`)
      pasa. Si bajó la cobertura, expliqué por qué.
- [ ] **Migración/rollback:** si toqué `migrations/sql/*`, la migración es
      idempotente (`IF NOT EXISTS`, checksum) y documenté cómo revertir o
      forward-fix. Si no aplica, marqué esta casilla.
- [ ] **Dashboards/alarmas:** si agregué una señal nueva (endpoint, cola, métrica),
      actualicé `terraform/dashboard.tf`/`observability.tf` y `docs/observability.md`.
- [ ] **Seguridad:** revisé auth/RBAC (`packages/shared/src/auth.js`), no agregué
      secretos ni logs con PII, y los diagnósticos siguen apagados en prod
      (`ENABLE_DIAGNOSTICS=false`). Ver `SECURITY.md`.
- [ ] **Documentación:** actualicé `README.md`/`docs/`/OpenAPI/ADR según el cambio.
      `scripts/check-docs-links.sh` pasa.
- [ ] **CI required verde:** el check `CI required` está en verde (no alcanza con
      jobs individuales; `ci-required` agrega todos).

## Notas para el reviewer

<!-- Trade-offs, partes que conviene mirar primero, riesgo residual. -->
