-- Fase 5.5: stock invariant — evita stock negativo y sincroniza productos.stock
-- Lógica: al insertar en movimientos_stock, ajusta productos.stock.
--   entrada → stock + cantidad
--   salida  → stock - cantidad (falla si resultante <0)
-- También maneja UPDATE/DELETE para mantener invariante.

CREATE OR REPLACE FUNCTION check_and_update_stock()
RETURNS TRIGGER AS $$
DECLARE
  current_stock INTEGER;
  new_stock INTEGER;
BEGIN
  -- Lock fila producto para evitar race
  SELECT stock INTO current_stock FROM productos WHERE id = COALESCE(NEW.producto_id, OLD.producto_id) FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    IF NEW.tipo = 'entrada' THEN
      new_stock := current_stock + NEW.cantidad;
    ELSIF NEW.tipo = 'salida' THEN
      new_stock := current_stock - NEW.cantidad;
      IF new_stock < 0 THEN
        RAISE EXCEPTION 'stock insuficiente para producto %: stock=% cantidad=%', NEW.producto_id, current_stock, NEW.cantidad;
      END IF;
    END IF;
    UPDATE productos SET stock = new_stock, updated_at = NOW() WHERE id = NEW.producto_id;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Revertir viejo y aplicar nuevo (simplificado: solo si cambió)
    -- Para simplicidad, recalcular desde movimientos (más seguro) o revertir
    RAISE EXCEPTION 'UPDATE en movimientos_stock no soportado — use DELETE+INSERT';
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.tipo = 'entrada' THEN
      new_stock := current_stock - OLD.cantidad;
      IF new_stock < 0 THEN
        RAISE EXCEPTION 'delete entrada dejaría stock negativo';
      END IF;
    ELSE
      new_stock := current_stock + OLD.cantidad;
    END IF;
    UPDATE productos SET stock = new_stock, updated_at = NOW() WHERE id = OLD.producto_id;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger INSERT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_invariant_insert') THEN
    CREATE TRIGGER trg_stock_invariant_insert
      AFTER INSERT ON movimientos_stock
      FOR EACH ROW
      EXECUTE FUNCTION check_and_update_stock();
  END IF;
END;
$$;

-- Trigger DELETE
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_invariant_delete') THEN
    CREATE TRIGGER trg_stock_invariant_delete
      AFTER DELETE ON movimientos_stock
      FOR EACH ROW
      EXECUTE FUNCTION check_and_update_stock();
  END IF;
END;
$$;

-- Índice para FK + trigger lookups ya existe (idx_stock_producto_id en 001)
