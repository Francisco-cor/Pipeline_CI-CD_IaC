# Data Model — ERP Pipeline (Fase 5)

> Esquema PostgreSQL 15, migraciones versionadas con `schema_migrations` + `pg_advisory_lock`.

## ER Diagram

```mermaid
erDiagram
    productos ||--o{ ordenes : "producto_id"
    productos ||--o{ movimientos_stock : "producto_id"
    productos {
        int id PK
        varchar nombre
        numeric precio
        int stock
        timestamptz created_at
        timestamptz updated_at
    }
    ordenes {
        int id PK
        int producto_id FK
        int cantidad
        numeric total
        varchar estado
        timestamptz created_at
        timestamptz updated_at
    }
    movimientos_stock {
        int id PK
        int producto_id FK
        int cantidad
        varchar tipo
        timestamptz created_at
        timestamptz updated_at
    }
    schema_migrations {
        text version PK
        timestamptz applied_at
    }
```

## Tablas

### productos
- `id SERIAL PK`, `nombre VARCHAR(255) NOT NULL`, `precio NUMERIC(10,2) CHECK >=0`, `stock INTEGER DEFAULT 0 CHECK >=0`, `created_at`, `updated_at`
- Índices: `idx_productos_nombre_trgm` GIN trigram (`006_trigram_search.sql:5`), `idx_productos_precio`, `idx_productos_stock`, `idx_productos_nombre_unique` (si no hay duplicados)

### ordenes
- `producto_id INTEGER FK productos(id)`, `cantidad CHECK >0`, `total CHECK >=0`, `estado IN ('pendiente','procesada','cancelada') DEFAULT 'pendiente'`, `created_at`, `updated_at` (añadido en `004_updated_at_ordenes_stock.sql:5`)
- Índices: `idx_ordenes_producto_id`, `idx_ordenes_estado`, `idx_ordenes_created_at DESC`

### movimientos_stock
- `producto_id FK`, `cantidad CHECK >0`, `tipo IN ('entrada','salida')`, `created_at`, `updated_at` (004)
- Índices: `idx_stock_producto_id`, `idx_stock_tipo`

### schema_migrations
- `version TEXT PK` (nombre archivo `001_...sql`), `applied_at`
- Gestionado por `migrations/run.js:14-48` (BEGIN/COMMIT por archivo, `pg_advisory_lock 727727727`, skip si ya aplicado)

## Triggers

### updated_at (002 + 004)
- Función `set_updated_at()` (`002_updated_at_trigger.sql:12`) → `NEW.updated_at = NOW()`
- Triggers: `productos_set_updated_at`, `ordenes_set_updated_at`, `movimientos_stock_set_updated_at` — `BEFORE UPDATE`

### stock invariant (005)
- Función `check_and_update_stock()` (`005_stock_invariant.sql:6-56`)
  - `INSERT entrada` → `productos.stock + cantidad`
  - `INSERT salida` → `productos.stock - cantidad`, `RAISE EXCEPTION` si <0
  - `DELETE` revierte
  - `FOR UPDATE` lock en `productos` evita race
- Triggers: `trg_stock_invariant_insert` (AFTER INSERT), `trg_stock_invariant_delete` (AFTER DELETE)
- `UPDATE` en `movimientos_stock` bloqueado (usar DELETE+INSERT)

## Migraciones

| Archivo | Descripción |
|---|---|
| `001_initial.sql:1-33` | Tablas + FK + CHECK + índices básicos |
| `002_updated_at_trigger.sql:1-33` | `set_updated_at()` + trigger productos |
| `003_industrial_bom_seed.sql:1-29` | 6 productos industriales (WHERE NOT EXISTS) |
| `004_updated_at_ordenes_stock.sql:1-32` | `updated_at` en ordenes/stock + triggers |
| `005_stock_invariant.sql:1-56` | Invariante stock |
| `006_trigram_search.sql:1-32` | `pg_trgm`, GIN, índices precio/stock/estado, unique nombre |
| `007_additional_bom_seed.sql:1-29` | 8 productos más (WHERE NOT EXISTS) |
| `run.js:11-65` | `pg_advisory_lock`, `schema_migrations`, transactional |

Ejecución: `migrations/run.js` → `docker compose` init `migrations` (`service_completed_successfully`) y `terraform/modules/compute/main.tf:165-177` `dependsOn SUCCESS`.

## Seeds

- `003` + `007` = 14 productos industriales (motores, PLCs, sensores, etc.)
- Idempotente via `WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = ...)`
- Si `idx_productos_nombre_unique` existe, se puede usar `ON CONFLICT (nombre) DO NOTHING` (006)

## Parámetros RDS (Fase 5.8)

- `terraform/modules/database/main.tf:54-75` → `aws_db_parameter_group postgres15` con `log_min_duration_statement=1000`, `pg_stat_statements`
- `storage_type = gp3` (vs gp2), `storage_encrypted = true`
- `backup_retention_period = var.environment == "prod" ? 7 : 1` (antes 0), `multi_az = prod ? true : false`, `deletion_protection = prod`, `performance_insights_retention 731d prod`

## Queries típicas

```sql
-- Búsqueda trigram
SELECT * FROM productos WHERE nombre ILIKE '%motor%' OR similarity(nombre, 'motor') > 0.3 ORDER BY similarity DESC;

-- Stock actual (ya denormalizado en productos.stock, pero verificable)
SELECT p.id, p.nombre, p.stock, COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.cantidad ELSE -m.cantidad END),0) as calc
FROM productos p LEFT JOIN movimientos_stock m ON m.producto_id=p.id GROUP BY p.id;

-- Ordenes pendientes por producto
SELECT producto_id, COUNT(*) FROM ordenes WHERE estado='pendiente' GROUP BY producto_id;
```

## Verificación local

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://erpadmin:test_password@localhost:5432/erpdb node migrations/run.js
psql $DATABASE_URL -c "SELECT version FROM schema_migrations ORDER BY version;"
psql $DATABASE_URL -c "\d productos" | grep trigram
```
