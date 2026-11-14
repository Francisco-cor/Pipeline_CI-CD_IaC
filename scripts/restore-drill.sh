#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# =============================================================================
# scripts/restore-drill.sh — RDS restore drill (PITR or snapshot)
#
# Default mode is --dry-run: prints the plan and validates local prerequisites.
# Nothing is created or deleted without --execute.
#
# Safety rules enforced by this script:
#   - The source instance is never modified, stopped or deleted.
#   - A scratch instance is created with a <source>-drill-<UTC> identifier and
#     tagged RestoreDrill=true / CreatedBy=restore-drill.sh.
#   - Production execution requires BOTH --environment prod and --confirm-prod.
#   - Cleanup only deletes instances recorded in this script's state directory
#     AND tagged as a drill for the same source. It never deletes the original.
#
# Usage:
#   bash scripts/restore-drill.sh                     # dry-run, PITR
#   bash scripts/restore-drill.sh --mode snapshot     # dry-run, latest snapshot
#   bash scripts/restore-drill.sh --execute           # create scratch + validate
#   bash scripts/restore-drill.sh --execute --cleanup # drill then delete scratch
#   bash scripts/restore-drill.sh --cleanup           # delete leftover scratch
#   bash scripts/restore-drill.sh --environment prod --confirm-prod --execute
#
# Requires: awscli v2, jq, psql, python3, network access to RDS:5432.
# See docs/runbooks/restore.md.
# =============================================================================

set -euo pipefail
umask 077

AWS_REGION="${AWS_REGION:-us-east-2}"
PROJECT_NAME="${PROJECT_NAME:-erp-pipeline}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
MODE="${MODE:-pitr}"
INSTANCE_CLASS="${INSTANCE_CLASS:-db.t3.micro}"
SOURCE_IDENTIFIER="${SOURCE_IDENTIFIER:-}"
RESTORE_TIME="${RESTORE_TIME:-}"
STATE_DIR="${DRILL_STATE_DIR:-${TMPDIR:-/tmp}/erp-restore-drills}"

EXECUTE=false
CLEANUP=false
CONFIRM_PROD=false
SKIP_SQL=false

usage() {
  awk 'NR == 1 { next } /^set / { exit } { sub(/^# ?/, ""); print }' "$0"
  cat <<'EOF'

Flags:
  --dry-run                 Print the plan only (default).
  --execute                 Create the scratch instance, wait and validate.
  --mode pitr|snapshot      Recovery source (default: pitr).
  --environment <env>       dev | staging | prod (default: dev).
  --source-identifier <id>  Override the RDS DBInstanceIdentifier.
  --restore-time <ISO8601>  PITR target (default: LatestRestorableTime).
  --instance-class <class>  Scratch class (default: db.t3.micro).
  --skip-sql                Skip psql validation (network unavailable).
  --cleanup                 Delete scratch instances created by this script.
  --confirm-prod            Required together with --environment prod --execute.
  -h, --help                This help.

Environment variables: AWS_REGION, PROJECT_NAME, ENVIRONMENT, MODE,
INSTANCE_CLASS, SOURCE_IDENTIFIER, RESTORE_TIME, DRILL_STATE_DIR.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) EXECUTE=false ;;
    --execute) EXECUTE=true ;;
    --mode) MODE="${2:?--mode requires a value}"; shift ;;
    --environment) ENVIRONMENT="${2:?--environment requires a value}"; shift ;;
    --source-identifier) SOURCE_IDENTIFIER="${2:?--source-identifier requires a value}"; shift ;;
    --restore-time) RESTORE_TIME="${2:?--restore-time requires a value}"; shift ;;
    --instance-class) INSTANCE_CLASS="${2:?--instance-class requires a value}"; shift ;;
    --skip-sql) SKIP_SQL=true ;;
    --cleanup) CLEANUP=true ;;
    --confirm-prod) CONFIRM_PROD=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

SOURCE_IDENTIFIER="${SOURCE_IDENTIFIER:-${PROJECT_NAME}-${ENVIRONMENT}-postgres}"

info() { echo "INFO: $*"; }
warn() { echo "WARN: $*" >&2; }
fail() { echo "ERROR: $*" >&2; exit 1; }

human_duration() {
  local s="$1"
  printf '%dh%02dm%02ds' $((s / 3600)) $(((s % 3600) / 60)) $((s % 60))
}

to_epoch() {
  python3 -c '
import datetime, sys
value = sys.argv[1].replace("Z", "+00:00")
print(int(datetime.datetime.fromisoformat(value).timestamp()))
' "$1"
}

case "$ENVIRONMENT" in
  dev | staging | prod) ;;
  *) fail "environment must be dev, staging or prod (got: $ENVIRONMENT)" ;;
esac

case "$MODE" in
  pitr | snapshot) ;;
  *) fail "mode must be pitr or snapshot (got: $MODE)" ;;
esac

if $EXECUTE && [ "$ENVIRONMENT" = "prod" ] && ! $CONFIRM_PROD; then
  fail "refusing to touch prod without --confirm-prod. Re-run: --environment prod --confirm-prod --execute"
fi

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

AWS_READY=false
if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1; then
    AWS_READY=true
  fi
fi

if ! $AWS_READY; then
  if $EXECUTE; then
    fail "AWS CLI with valid credentials is required for --execute (aws sts get-caller-identity failed)"
  fi
  warn "AWS CLI or credentials unavailable; the dry-run cannot resolve the live source"
fi

PSQL_AVAILABLE=true
if ! $SKIP_SQL; then
  if ! command -v psql >/dev/null 2>&1; then
    PSQL_AVAILABLE=false
    if $EXECUTE; then
      fail "psql is required for validation (use --skip-sql only if you accept an unvalidated restore)"
    fi
    warn "psql not found; SQL validation would be skipped"
  fi
fi

# -----------------------------------------------------------------------------
# Cleanup-only mode
# -----------------------------------------------------------------------------
cleanup_scratch() {
  mkdir -p "$STATE_DIR"
  local state id source region arn tags
  local files=("$STATE_DIR/${ENVIRONMENT}"-*.json)
  local found=0

  if [ ! -e "${files[0]}" ]; then
    info "no scratch state files for environment ${ENVIRONMENT} in ${STATE_DIR}"
    return 0
  fi

  for state in "${files[@]}"; do
    [ -f "$state" ] || continue
    found=$((found + 1))

    id=$(jq -r '.identifier // empty' "$state")
    source=$(jq -r '.source // empty' "$state")
    region=$(jq -r '.region // empty' "$state")
    region="${region:-$AWS_REGION}"

    if [ -z "$id" ] || [ -z "$source" ]; then
      warn "ignoring malformed state file: $state"
      continue
    fi

    case "$id" in
      "$source"-drill-*) ;;
      *)
        warn "skipping $id: does not belong to source $source"
        continue
        ;;
    esac

    if [[ ! "$id" =~ -drill-[0-9]{14}$ ]]; then
      warn "skipping $id: does not match the drill naming pattern"
      continue
    fi

    arn=$(aws rds describe-db-instances --db-instance-identifier "$id" --region "$region" \
      --query 'DBInstances[0].DBInstanceArn' --output text 2>/dev/null || true)

    if [ -z "$arn" ] || [ "$arn" = "None" ]; then
      info "scratch $id no longer exists; removing state file"
      rm -f "$state"
      continue
    fi

    tags=$(aws rds list-tags-for-resource --resource-name "$arn" --region "$region" \
      --query 'TagList' --output json)

    if ! jq -e '
      any(.[]; .Key == "RestoreDrill" and .Value == "true") and
      any(.[]; .Key == "CreatedBy" and .Value == "restore-drill.sh") and
      any(.[]; .Key == "SourceInstance" and .Value == $source)
    ' --arg source "$source" <<<"$tags" >/dev/null; then
      warn "refusing to delete $id: tags do not prove this script created it"
      continue
    fi

    info "deleting scratch $id (source $source untouched)"
    aws rds delete-db-instance --db-instance-identifier "$id" \
      --skip-final-snapshot --delete-automated-backups --region "$region" >/dev/null
    aws rds wait db-instance-deleted --db-instance-identifier "$id" --region "$region" || \
      warn "waiter timed out for $id; verify in the console"
    rm -f "$state"
    info "scratch $id deleted"
  done

  [ "$found" -gt 0 ] || info "no scratch state files for environment ${ENVIRONMENT}"
}

if $CLEANUP && ! $EXECUTE; then
  $AWS_READY || fail "AWS CLI with valid credentials is required for --cleanup"
  info "cleanup-only mode for environment ${ENVIRONMENT}"
  cleanup_scratch
  exit 0
fi

if $EXECUTE && $CLEANUP; then
  trap 'cleanup_scratch || true' EXIT
fi

# -----------------------------------------------------------------------------
# Resolve source and restore point (read-only)
# -----------------------------------------------------------------------------
SOURCE_JSON=""
if $AWS_READY; then
  if ! SOURCE_JSON=$(aws rds describe-db-instances --db-instance-identifier "$SOURCE_IDENTIFIER" \
    --region "$AWS_REGION" --query 'DBInstances[0]' --output json 2>/dev/null); then
    if $EXECUTE; then
      fail "source instance not found: $SOURCE_IDENTIFIER (check --source-identifier and AWS_REGION)"
    fi
    warn "source instance not found: $SOURCE_IDENTIFIER"
    SOURCE_JSON=""
  fi
fi

SOURCE_STATUS="unknown"
SUBNET_GROUP=""
PARAM_GROUP=""
SG_IDS=""
LATEST_RESTORABLE=""
SNAPSHOT_ID=""
SNAPSHOT_CREATED=""
RESTORE_POINT_ISO=""

if [ -n "$SOURCE_JSON" ] && [ "$SOURCE_JSON" != "null" ]; then
  SOURCE_STATUS=$(jq -r '.DBInstanceStatus // "unknown"' <<<"$SOURCE_JSON")
  SUBNET_GROUP=$(jq -r '.DBSubnetGroup.DBSubnetGroupName // ""' <<<"$SOURCE_JSON")
  PARAM_GROUP=$(jq -r '.DBParameterGroups[0].DBParameterGroupName // ""' <<<"$SOURCE_JSON")
  SG_IDS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$SOURCE_JSON")
  LATEST_RESTORABLE=$(jq -r '.LatestRestorableTime // ""' <<<"$SOURCE_JSON")
fi

if [ "$MODE" = "pitr" ]; then
  RESTORE_POINT_ISO="${RESTORE_TIME:-$LATEST_RESTORABLE}"
  if [ -z "$RESTORE_POINT_ISO" ] && $EXECUTE; then
    fail "no LatestRestorableTime for $SOURCE_IDENTIFIER; pass --restore-time or use --mode snapshot"
  fi
else
  if $AWS_READY; then
    SNAPSHOT_JSON=$(aws rds describe-db-snapshots --db-instance-identifier "$SOURCE_IDENTIFIER" \
      --region "$AWS_REGION" --output json 2>/dev/null || echo '{"DBSnapshots":[]}')
    SNAPSHOT_ID=$(jq -r '[.DBSnapshots[] | select(.Status == "available")] | sort_by(.SnapshotCreateTime) | reverse | .[0].DBSnapshotIdentifier // ""' <<<"$SNAPSHOT_JSON")
    SNAPSHOT_CREATED=$(jq -r '[.DBSnapshots[] | select(.Status == "available")] | sort_by(.SnapshotCreateTime) | reverse | .[0].SnapshotCreateTime // ""' <<<"$SNAPSHOT_JSON")
  fi
  RESTORE_POINT_ISO="$SNAPSHOT_CREATED"
  if [ -z "$SNAPSHOT_ID" ] && $EXECUTE; then
    fail "no available automated or manual snapshot for $SOURCE_IDENTIFIER"
  fi
fi

if [ "$MODE" = "pitr" ] && [ -n "$RESTORE_TIME" ]; then
  if ! python3 -c 'import datetime,sys; datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))' "$RESTORE_TIME" 2>/dev/null; then
    fail "--restore-time is not a valid ISO-8601 timestamp: $RESTORE_TIME"
  fi
  RESTORE_TIME_EPOCH=$(to_epoch "$RESTORE_TIME")
  NOW_EPOCH=$(date +%s)
  if [ "$RESTORE_TIME_EPOCH" -gt "$NOW_EPOCH" ]; then
    fail "--restore-time cannot be in the future"
  fi
fi

if [ "$MODE" = "snapshot" ] && [ -n "$RESTORE_TIME" ]; then
  warn "--restore-time is ignored in snapshot mode; using the latest available snapshot"
fi

DRILL_SUFFIX="-drill-$(date -u +%Y%m%d%H%M%S)"
MAX_SOURCE_LEN=$((63 - ${#DRILL_SUFFIX}))
DRILL_IDENTIFIER="${SOURCE_IDENTIFIER:0:$MAX_SOURCE_LEN}${DRILL_SUFFIX}"
STATE_FILE="${STATE_DIR}/${ENVIRONMENT}-${DRILL_IDENTIFIER}.json"

# -----------------------------------------------------------------------------
# Plan
# -----------------------------------------------------------------------------
echo ""
echo "=== RDS restore drill — ${PROJECT_NAME} / ${ENVIRONMENT} ==="
echo "Mode:                ${MODE}"
echo "AWS region:          ${AWS_REGION}"
echo "Source instance:     ${SOURCE_IDENTIFIER} (status: ${SOURCE_STATUS})"
echo "Scratch instance:    ${DRILL_IDENTIFIER}"
echo "Instance class:      ${INSTANCE_CLASS}"
echo "Subnet group:        ${SUBNET_GROUP:-<resolve from source>}"
echo "Parameter group:     ${PARAM_GROUP:-<engine default>}"
echo "Security groups:     ${SG_IDS:-<resolve from source>}"
if [ "$MODE" = "pitr" ]; then
  echo "Restore time:        ${RESTORE_POINT_ISO:-<LatestRestorableTime>}"
else
  echo "Snapshot:            ${SNAPSHOT_ID:-<latest available>}"
  echo "Snapshot created:    ${SNAPSHOT_CREATED:-unknown}"
fi
echo "State file:          ${STATE_FILE}"
if $SKIP_SQL || ! $PSQL_AVAILABLE; then
  echo "SQL validation:      skipped (--skip-sql or psql missing)"
else
  echo "SQL validation:      enabled"
fi
echo "Cleanup after run:   $($CLEANUP && echo 'yes' || echo 'no (use --cleanup later)')"
echo ""

if ! $EXECUTE; then
  info "DRY-RUN: no AWS resources will be created or deleted."
  if [ "$ENVIRONMENT" = "prod" ]; then
    warn "prod execute requires: --environment prod --confirm-prod --execute"
  fi
  info "Next step: bash scripts/restore-drill.sh --execute${MODE:+ --mode $MODE}"
  exit 0
fi

[ "$SOURCE_STATUS" = "available" ] || fail "source $SOURCE_IDENTIFIER is not available (status: $SOURCE_STATUS)"

mkdir -p "$STATE_DIR"

# -----------------------------------------------------------------------------
# Restore
# -----------------------------------------------------------------------------
START_EPOCH=$(date +%s)
START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
info "starting restore at ${START_ISO}"

jq -n \
  --arg identifier "$DRILL_IDENTIFIER" \
  --arg source "$SOURCE_IDENTIFIER" \
  --arg region "$AWS_REGION" \
  --arg mode "$MODE" \
  --arg started "$START_ISO" \
  '{identifier: $identifier, source: $source, region: $region, mode: $mode, started_at: $started}' \
  >"$STATE_FILE"

if [ "$MODE" = "pitr" ]; then
  RESTORE_ARGS=(--source-db-instance-identifier "$SOURCE_IDENTIFIER"
    --target-db-instance-identifier "$DRILL_IDENTIFIER"
    --restore-time "$RESTORE_POINT_ISO"
    --db-instance-class "$INSTANCE_CLASS"
    --no-publicly-accessible --no-multi-az --no-deletion-protection)
else
  RESTORE_ARGS=(--db-instance-identifier "$DRILL_IDENTIFIER"
    --db-snapshot-identifier "$SNAPSHOT_ID"
    --db-instance-class "$INSTANCE_CLASS"
    --no-publicly-accessible --no-multi-az --no-deletion-protection)
fi

if [ -n "$SUBNET_GROUP" ]; then
  RESTORE_ARGS+=(--db-subnet-group-name "$SUBNET_GROUP")
fi
if [ -n "$PARAM_GROUP" ]; then
  RESTORE_ARGS+=(--db-parameter-group-name "$PARAM_GROUP")
fi
if [ -n "$SG_IDS" ]; then
  read -r -a SG_ARRAY <<<"$SG_IDS"
  RESTORE_ARGS+=(--vpc-security-group-ids "${SG_ARRAY[@]}")
fi

if [ "$MODE" = "pitr" ]; then
  aws rds restore-db-instance-to-point-in-time "${RESTORE_ARGS[@]}" --region "$AWS_REGION" >/dev/null
else
  aws rds restore-db-instance-from-db-snapshot "${RESTORE_ARGS[@]}" --region "$AWS_REGION" >/dev/null
fi
info "restore requested; waiting for ${DRILL_IDENTIFIER} to become available (this can take 10-40 min)"

aws rds wait db-instance-available --db-instance-identifier "$DRILL_IDENTIFIER" --region "$AWS_REGION"

DRILL_ARN=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_IDENTIFIER" \
  --region "$AWS_REGION" --query 'DBInstances[0].DBInstanceArn' --output text)
DRILL_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_IDENTIFIER" \
  --region "$AWS_REGION" --query 'DBInstances[0].Endpoint.Address' --output text)

aws rds add-tags-to-resource --resource-name "$DRILL_ARN" --region "$AWS_REGION" \
  --tags Key=RestoreDrill,Value=true Key=CreatedBy,Value=restore-drill.sh \
  Key=SourceInstance,Value="$SOURCE_IDENTIFIER" Key=DrillMode,Value="$MODE" \
  Key=DrillStartedAt,Value="$START_ISO" >/dev/null

info "scratch available at ${DRILL_ENDPOINT}"

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------
VALIDATION_STATUS="skipped"
if ! $SKIP_SQL; then
  DB_URL=$(aws ssm get-parameter --name "/${PROJECT_NAME}/${ENVIRONMENT}/db-url" \
    --with-decryption --region "$AWS_REGION" --query Parameter.Value --output text)

  DB_CREDS=$(python3 - "$DB_URL" <<'PY'
import sys
import urllib.parse

url = urllib.parse.urlparse(sys.argv[1])
user = urllib.parse.unquote(url.username or "")
password = urllib.parse.unquote(url.password or "")
database = urllib.parse.unquote((url.path or "/").lstrip("/"))
print("\t".join([user, password, database]))
PY
  )
  IFS=$'\t' read -r DB_USER DB_PASS DB_NAME <<<"$DB_CREDS"

  run_sql() {
    PGPASSWORD="$DB_PASS" PGSSLMODE=require psql \
      -h "$DRILL_ENDPOINT" -p 5432 -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tA -c "$1"
  }

  info "waiting for SQL connectivity"
  SQL_READY=false
  for _ in $(seq 1 60); do
    if run_sql "SELECT 1" >/dev/null 2>&1; then
      SQL_READY=true
      break
    fi
    sleep 5
  done
  $SQL_READY || fail "cannot connect with psql to ${DRILL_ENDPOINT}; run from a host with SG access or use --skip-sql"

  TABLES=$(run_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
  MIGRATIONS=$(run_sql "SELECT count(*) FROM schema_migrations;")
  PRODUCTOS=$(run_sql "SELECT count(*) FROM productos;")
  ORDENES=$(run_sql "SELECT count(*) FROM ordenes;")
  MOVIMIENTOS=$(run_sql "SELECT count(*) FROM movimientos_stock;")
  OUTBOX_PENDING=$(run_sql "SELECT count(*) FROM outbox_events WHERE published_at IS NULL;")
  AUDIT_ROWS=$(run_sql "SELECT count(*) FROM audit_log;")
  ORPHAN_ORDERS=$(run_sql "SELECT count(*) FROM ordenes o LEFT JOIN productos p ON p.id=o.producto_id WHERE p.id IS NULL;")
  ORPHAN_STOCK=$(run_sql "SELECT count(*) FROM movimientos_stock m LEFT JOIN productos p ON p.id=m.producto_id WHERE p.id IS NULL;")
  INVALID_PRODUCTS=$(run_sql "SELECT count(*) FROM productos WHERE precio < 0 OR stock < 0;")
  CRITICAL_INDEXES=$(run_sql "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('idx_productos_nombre_trgm','idx_outbox_pending','idx_idempotency_created_at','idx_audit_log_occurred_at');")

  [ "$TABLES" -ge 8 ] || fail "schema check failed: expected >=8 base tables, got $TABLES"
  [ "$MIGRATIONS" -ge 1 ] || fail "schema_migrations is empty"
  [ "$ORPHAN_ORDERS" -eq 0 ] || fail "referential integrity failed: $ORPHAN_ORDERS orphan orders"
  [ "$ORPHAN_STOCK" -eq 0 ] || fail "referential integrity failed: $ORPHAN_STOCK orphan stock movements"
  [ "$INVALID_PRODUCTS" -eq 0 ] || fail "business invariant failed: $INVALID_PRODUCTS invalid products"
  [ "$CRITICAL_INDEXES" -eq 4 ] || fail "index check failed: expected 4 critical indexes, got $CRITICAL_INDEXES"

  VALIDATION_STATUS="passed"
  echo ""
  echo "Validation:"
  echo "  base tables:        ${TABLES}"
  echo "  migrations:         ${MIGRATIONS}"
  echo "  productos:          ${PRODUCTOS}"
  echo "  ordenes:            ${ORDENES}"
  echo "  movimientos_stock:  ${MOVIMIENTOS}"
  echo "  outbox pending:     ${OUTBOX_PENDING}"
  echo "  audit_log:          ${AUDIT_ROWS}"
  echo "  orphan orders:      ${ORPHAN_ORDERS}"
  echo "  orphan stock:       ${ORPHAN_STOCK}"
  echo "  invalid products:   ${INVALID_PRODUCTS}"
  echo "  critical indexes:   ${CRITICAL_INDEXES}"
fi

END_EPOCH=$(date +%s)
END_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RTO_SECONDS=$((END_EPOCH - START_EPOCH))

RPO_SECONDS=0
if [ -n "$RESTORE_POINT_ISO" ]; then
  RESTORE_POINT_EPOCH=$(to_epoch "$RESTORE_POINT_ISO")
  RPO_SECONDS=$((START_EPOCH - RESTORE_POINT_EPOCH))
  [ "$RPO_SECONDS" -ge 0 ] || RPO_SECONDS=0
fi

jq \
  --arg finished "$END_ISO" \
  --arg endpoint "$DRILL_ENDPOINT" \
  --arg validation "$VALIDATION_STATUS" \
  --arg rto "$RTO_SECONDS" \
  --arg rpo "$RPO_SECONDS" \
  '. + {finished_at: $finished, endpoint: $endpoint, validation: $validation, rto_seconds: ($rto | tonumber), rpo_seconds: ($rpo | tonumber)}' \
  "$STATE_FILE" >"${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"

echo ""
echo "=== Drill result ==="
echo "Restore point:  ${RESTORE_POINT_ISO:-unknown}"
echo "Started:        ${START_ISO}"
echo "Finished:       ${END_ISO}"
echo "RTO (measured): $(human_duration "$RTO_SECONDS") (${RTO_SECONDS}s)"
echo "RPO (data age): $(human_duration "$RPO_SECONDS") (${RPO_SECONDS}s)"
echo "Validation:     ${VALIDATION_STATUS}"
echo "Scratch:        ${DRILL_IDENTIFIER} @ ${DRILL_ENDPOINT}"
echo ""
echo "Evidence row (paste into docs/runbooks/restore.md#8-evidencia):"
echo "| ${START_ISO} | ${ENVIRONMENT} | ${MODE} | ${RESTORE_POINT_ISO:-unknown} | $(human_duration "$RPO_SECONDS") | ${START_ISO} | ${END_ISO} | $(human_duration "$RTO_SECONDS") | ${VALIDATION_STATUS} | <responsable> | <ticket> |"
echo ""
if ! $CLEANUP; then
  warn "scratch instance is still running and billable."
  warn "cleanup: bash scripts/restore-drill.sh --environment ${ENVIRONMENT} --cleanup"
fi
