-- Client retries for unsafe POSTs. The unique (scope, key) pair is the
-- concurrency guard; request_hash detects the same key with a different body.
-- response_status/response_json let a duplicate replay the original response.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              BIGSERIAL PRIMARY KEY,
  scope           VARCHAR(100) NOT NULL,
  key             VARCHAR(200) NOT NULL,
  request_hash    CHAR(64) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_json   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency_keys (created_at);
