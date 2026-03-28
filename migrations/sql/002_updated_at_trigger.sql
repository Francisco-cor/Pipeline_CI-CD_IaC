-- Auto-update updated_at on productos rows.
--
-- The productos table has an updated_at column but no mechanism to keep it
-- current on UPDATE. Without this trigger, updated_at stays frozen at the
-- insert timestamp regardless of how many times the row is modified.
--
-- Uses CREATE OR REPLACE so the migration is idempotent on re-run.
-- The trigger itself uses IF NOT EXISTS (via DROP/CREATE pattern is not
-- idempotent; instead we rely on the function being replaceable and guard
-- the trigger creation with a DO block).

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Guard against re-running: only create the trigger if it doesn't exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'productos_set_updated_at'
  ) THEN
    CREATE TRIGGER productos_set_updated_at
      BEFORE UPDATE ON productos
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;
