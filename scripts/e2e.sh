#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/e2e.sh — smoke e2e contra compose (nginx → servicios)
# Uso: ./scripts/e2e.sh [base_url]
# Requiere: docker compose up --build -d y jq (opcional)

set -euo pipefail

BASE_URL="${1:-http://localhost:80}"
echo "=== e2e smoke — $BASE_URL ==="

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "PASS: $1"; }

# Helpers
check() {
  local path="$1"
  local expected="${2:-200}"
  local code
  code=$(curl -s -o /tmp/e2e_body -w "%{http_code}" "$BASE_URL$path")
  if [ "$code" != "$expected" ]; then
    echo "--- body ---"
    cat /tmp/e2e_body || true
    fail "$path → expected $expected got $code"
  else
    pass "$path → $code"
  fi
}

check_json() {
  local path="$1"
  local jq_filter="$2"
  local body
  body=$(curl -s "$BASE_URL$path")
  if ! echo "$body" | jq -e "$jq_filter" >/dev/null 2>&1; then
    echo "Body: $body"
    fail "jq $jq_filter failed for $path"
  else
    pass "jq $jq_filter for $path"
  fi
}

# 1. Health
check "/health" 200
check "/api/v1/productos/health" 200
check "/api/v1/ordenes/health" 200
check "/api/v1/stock/health" 200
check "/api/v1/productos/health/live" 200

# 2. Productos CRUD + pagination
echo "--- productos ---"
check "/api/v1/productos?limit=2&page=1" 200
# Create
CREATE_RESP=$(curl -s -X POST "$BASE_URL/api/v1/productos" -H "Content-Type: application/json" -d '{"nombre":"e2e-widget","precio":12.5,"stock":3}')
echo "$CREATE_RESP" | jq -e '.data.id' >/dev/null || fail "create producto"
ID=$(echo "$CREATE_RESP" | jq -r '.data.id')
pass "POST producto id=$ID"
check_json "/api/v1/productos?limit=1" '.data | length == 1'
# Pagination headers
CODE=$(curl -s -D - -o /tmp/body "$BASE_URL/api/v1/productos?limit=1" | grep -i "^X-Total-Count" || true)
[ -n "$CODE" ] && pass "X-Total-Count header" || fail "missing X-Total-Count"
CODE=$(curl -s -D - -o /tmp/body "$BASE_URL/api/v1/productos?limit=1" | grep -i "^Link:" || true)
[ -n "$CODE" ] && pass "Link header" || echo "WARN no Link header (maybe single page)"

# 3. Ordenes — FK check + create
echo "--- ordenes ---"
check "/api/v1/ordenes?limit=1" 200
# 404 for bad FK
check "/api/v1/ordenes" 200 # GET ok
BAD=$(curl -s -o /tmp/b -w "%{http_code}" -X POST "$BASE_URL/api/v1/ordenes" -H "Content-Type: application/json" -d '{"producto_id":999999,"cantidad":1,"total":10}')
[ "$BAD" = "404" ] && pass "FK 404" || fail "FK should 404 got $BAD"
OK=$(curl -s -X POST "$BASE_URL/api/v1/ordenes" -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":2,\"total\":25}")
echo "$OK" | jq -e '.data.id' >/dev/null && pass "POST orden" || fail "POST orden"

# 4. Stock
echo "--- stock ---"
check "/api/v1/stock?limit=1" 200
STOCK=$(curl -s -X POST "$BASE_URL/api/v1/stock" -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":5,\"tipo\":\"entrada\"}")
echo "$STOCK" | jq -e '.data.id' >/dev/null && pass "POST stock entrada" || fail "POST stock"
BAD_TIPO=$(curl -s -o /tmp/b -w "%{http_code}" -X POST "$BASE_URL/api/v1/stock" -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":1,\"tipo\":\"bad\"}")
[ "$BAD_TIPO" = "400" ] && pass "tipo enum 400" || fail "tipo should 400 got $BAD_TIPO"

# 5. Security headers & requestId
echo "--- security ---"
HDR=$(curl -s -I "$BASE_URL/api/v1/productos" | tr -d '\r' | grep -i "^X-Request-Id" || true)
[ -n "$HDR" ] && pass "X-Request-Id" || fail "missing X-Request-Id"
HDR2=$(curl -s -I "$BASE_URL/api/v1/productos" | grep -i "X-Content-Type-Options" || true)
[ -n "$HDR2" ] && pass "helmet headers" || echo "WARN helmet header missing (check helmet)"

# 6. 404
check "/no-existe-xyz" 404

echo "=== e2e smoke OK ==="
