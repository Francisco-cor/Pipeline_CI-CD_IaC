-- Transactional event delivery for SQS.
-- The producer inserts the domain row and its outbox row in one transaction.
-- The consumer records event_id before acknowledging SQS so redeliveries are
-- harmless after a successful commit.

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id       UUID PRIMARY KEY,
  event_type     VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(100) NOT NULL,
  aggregate_id   BIGINT NOT NULL,
  dedupe_key     VARCHAR(255) NOT NULL UNIQUE,
  payload        JSONB NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at      TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS inbox_events (
  event_id     UUID PRIMARY KEY,
  event_type   VARCHAR(100) NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  last_error   TEXT
);
