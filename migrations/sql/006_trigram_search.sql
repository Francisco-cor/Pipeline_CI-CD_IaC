-- Fase 5.6: índices + búsqueda trigram en productos.nombre
-- Permite búsqueda difusa: SELECT * FROM productos WHERE nombre ILIKE '%motor%' o similarity

-- Extensión pg_trgm (requiere superuser; en RDS el master user puede crear)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index para ILIKE y similarity
CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm ON productos USING gin (nombre gin_trgm_ops);

-- Índice adicional para búsquedas por precio y stock (rangos)
CREATE INDEX IF NOT EXISTS idx_productos_precio ON productos (precio);
CREATE INDEX IF NOT EXISTS idx_productos_stock ON productos (stock);

-- Índice para ordenes estado y created_at (filtros comunes)
CREATE INDEX IF NOT EXISTS idx_ordenes_estado ON ordenes (estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_created_at ON ordenes (created_at DESC);

-- Índice para stock tipo
CREATE INDEX IF NOT EXISTS idx_stock_tipo ON movimientos_stock (tipo);

-- Unique constraint para nombre si no existe (para ON CONFLICT en seed)
-- No forzamos unique si ya hay duplicados; creamos índice unique si posible
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_productos_nombre_unique') THEN
    -- Crear índice unique solo si no hay duplicados
    IF NOT EXISTS (SELECT nombre, COUNT(*) FROM productos GROUP BY nombre HAVING COUNT(*) > 1) THEN
      CREATE UNIQUE INDEX idx_productos_nombre_unique ON productos (nombre);
    END IF;
  END IF;
END;
$$;
