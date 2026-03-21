-- Initial schema for ERP pipeline portfolio project
-- Run by the migrations init container before any service starts

CREATE TABLE IF NOT EXISTS productos (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(255) NOT NULL,
  precio      NUMERIC(10, 2) NOT NULL CHECK (precio >= 0),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ordenes (
  id          SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
  total       NUMERIC(10, 2) NOT NULL CHECK (total >= 0),
  estado      VARCHAR(50) NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente', 'procesada', 'cancelada')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS movimientos_stock (
  id          SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
  tipo        VARCHAR(20) NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_ordenes_producto_id ON ordenes (producto_id);
CREATE INDEX IF NOT EXISTS idx_stock_producto_id ON movimientos_stock (producto_id);
