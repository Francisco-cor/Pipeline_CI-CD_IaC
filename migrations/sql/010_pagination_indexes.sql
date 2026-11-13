-- Deterministic pagination: every list orders by (created_at, id) and can use
-- these composite indexes instead of sorting the whole table on each request.

CREATE INDEX IF NOT EXISTS idx_productos_created_at_id
  ON productos (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_created_at_id
  ON movimientos_stock (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ordenes_created_at_id
  ON ordenes (created_at DESC, id DESC);
