-- Audit trail for state-changing operations.
--
-- actor_* columns are nullable on purpose: authentication can be disabled in
-- local development, but the mutation still needs an audit row. In production
-- AUTH_ENABLED defaults to true, so actor_sub/actor_role are populated.
--
-- status stores the HTTP status returned to the caller (not the write result):
-- 201 means the mutation committed; 4xx/5xx are valuable for detecting denied
-- or failed attempts. metadata is intentionally open-ended JSONB (method, path)
-- so new services can add context without a migration.

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_sub    TEXT,
  actor_role   TEXT,
  tenant_id    TEXT,
  action       VARCHAR(100) NOT NULL,
  resource     VARCHAR(100) NOT NULL,
  resource_id  TEXT,
  status       INTEGER NOT NULL,
  request_id   VARCHAR(128),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at
  ON audit_log (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_sub
  ON audit_log (actor_sub, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
  ON audit_log (tenant_id, occurred_at DESC);
