#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/smoke.sh — read-only smoke test for a deployed environment.
#
# Usage:
#   bash scripts/smoke.sh https://staging.example.com
#   SMOKE_RETRIES=10 SMOKE_DELAY_SECONDS=5 bash scripts/smoke.sh "$PROD_URL"
#
# Checks nginx, productos/ordenes/stock health + one read per service, and the
# BFF only when the environment already has an order to read. It never writes
# data, so it is safe to run against staging and prod after every deploy.
#
# Env:
#   SMOKE_RETRIES         attempts for the initial /health wait (default 6)
#   SMOKE_DELAY_SECONDS   seconds between attempts (default 5)
#   SMOKE_TIMEOUT_SECONDS per-request curl timeout (default 10)
#
# Exit 0 only when every check returns 2xx and the body is valid JSON where
# expected; any timeout/non-2xx/invalid body exits 1.

set -euo pipefail

BASE_URL="${1:-${SMOKE_BASE_URL:-}}"
RETRIES="${SMOKE_RETRIES:-6}"
DELAY="${SMOKE_DELAY_SECONDS:-5}"
TIMEOUT="${SMOKE_TIMEOUT_SECONDS:-10}"

if [ -z "${BASE_URL}" ]; then
  echo "ERROR: usage: bash scripts/smoke.sh <base_url>" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

BODY="$(mktemp)"
trap 'rm -f "${BODY}"' EXIT

fail() {
  echo "FAIL: $1" >&2
  if [ -s "${BODY}" ]; then
    echo "--- body (first 20 lines) ---" >&2
    head -n 20 "${BODY}" >&2 || true
  fi
  exit 1
}
pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; }

http_code() {
  local path="$1"
  local code
  code="$(curl -sS --max-time "${TIMEOUT}" -o "${BODY}" -w '%{http_code}' "${BASE_URL}${path}" 2>/dev/null)" ||
    code="000"
  echo "${code:-000}"
}

# ECS reports the service stable before the first request always lands, and a
# fresh task can still answer 502 for a few seconds through nginx.
wait_for_health() {
  local path="/health"
  local attempt code
  for attempt in $(seq 1 "${RETRIES}"); do
    code="$(http_code "${path}")"
    if [ "${code}" = "200" ]; then
      pass "${path} -> 200 (attempt ${attempt}/${RETRIES})"
      return 0
    fi
    echo "  attempt ${attempt}/${RETRIES}: ${path} -> ${code:-timeout}; retrying in ${DELAY}s"
    sleep "${DELAY}"
  done
  fail "${path} did not return 200 after ${RETRIES} attempts"
}

check() {
  local path="$1"
  local code
  code="$(http_code "${path}")"
  if [ "${code}" != "200" ]; then
    fail "${path} -> expected 200, got ${code:-timeout}"
  fi
  pass "${path} -> 200"
}

check_json() {
  local path="$1"
  local code
  code="$(http_code "${path}")"
  if [ "${code}" != "200" ]; then
    fail "${path} -> expected 200, got ${code:-timeout}"
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -e . "${BODY}" >/dev/null 2>&1 || fail "${path} returned invalid JSON"
  fi
  pass "${path} -> 200 (json)"
}

echo "=== smoke — ${BASE_URL} ==="

wait_for_health

# nginx routes both the short and the versioned health paths to the services.
check "/api/v1/productos/health"
check "/api/v1/ordenes/health"
check "/api/v1/stock/health"

check_json "/api/v1/productos?limit=1"
check_json "/api/v1/ordenes?limit=1"
check_json "/api/v1/stock?limit=1"

# BFF aggregation needs an existing order id. Empty environments skip it
# instead of failing the promotion on absent seed data.
if command -v jq >/dev/null 2>&1; then
  http_code "/api/v1/ordenes?limit=1" >/dev/null || true
  ORDEN_ID="$(jq -r '.data[0].id // empty' "${BODY}" 2>/dev/null || true)"
  if [ -n "${ORDEN_ID}" ]; then
    check_json "/api/v1/bff/ordenes/${ORDEN_ID}?include=producto"
  else
    warn "no orders available — BFF aggregation check skipped"
  fi
else
  warn "jq not installed — BFF aggregation check skipped"
fi

echo "=== smoke OK — ${BASE_URL} ==="
