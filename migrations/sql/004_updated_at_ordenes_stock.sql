-- Fase 5.4: updated_at para ordenes y movimientos_stock
-- Añade coluna updated_at donde falta y crea triggers (idempotente)

-- productos ya tiene updated_at + trigger en 002; aquí extendemos a otras tablas

-- Ordenes: añadir updated_at si no existe
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- movimientos_stock: añadir updated_at
ALTER TABLE movimientos_stock ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Reusa función set_updated_at() creada en 002 (CREATE OR REPLACE)
-- Crea triggers para ordenes y stock si no existen

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ordenes_set_updated_at') THEN
    CREATE TRIGGER ordenes_set_updated_at
      BEFORE UPDATE ON ordenes
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'movimientos_stock_set_updated_at') THEN
    CREATE TRIGGER movimientos_stock_set_updated_at
      BEFORE UPDATE ON movimientos_stock
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;
