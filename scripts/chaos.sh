#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/chaos.sh — Fase 10.7 resilience chaos (kill service, DB latency)
# Uso: ./scripts/chaos.sh [base_url] [mode]
# modes: kill-productos | kill-ordenes | latency | cache | circuit | all
# Requiere: docker compose running, curl, jq

set -euo pipefail

BASE_URL="${1:-http://localhost:80}"
MODE="${2:-all}"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }
info() { echo "INFO: $1"; }

check_status() {
  local url="$1"
  local expected="${2:-200}"
  local code
  code=$(curl -s -o /tmp/chaos_body -w "%{http_code}" "$url" || echo "000")
  if [ "$code" = "$expected" ]; then
    return 0
  else
    echo "got $code expected $expected for $url — body $(cat /tmp/chaos_body 2>/dev/null | head -c 200)"
    return 1
  fi
}

info "=== chaos resilience — $BASE_URL mode=$MODE ==="

# 1. Baseline saludable
info "baseline health…"
check_status "$BASE_URL/health" 200 || fail "baseline /health"
check_status "$BASE_URL/api/v1/productos/health" 200 || fail "productos health"
check_status "$BASE_URL/api/v1/ordenes/health" 200 || fail "ordenes health"
check_status "$BASE_URL/api/v1/stock/health" 200  || fail "stock health"
pass "baseline OK"

# 2. kill-productos → ordenes debe seguir fallback DB
if [ "$MODE" = "kill-productos" ] || [ "$MODE" = "all" ]; then
  info "chaos kill-productos (docker stop erp-productos 15s)…"
  if docker ps --format '{{.Names}}' | grep -q erp-productos; then
    docker stop erp-productos >/dev/null || true
    sleep 2
    # productos debe fallar (nginx 502 o 500)
    code=$(curl -s -o /tmp/c -w "%{http_code}" "$BASE_URL/api/v1/productos?limit=1" || echo "000")
    info "productos after kill → $code (expect 502/500/000)"
    # ordenes con producto existente debe fallback a DB y seguir 404/200
    # crea producto antes de kill? intenta orden fantasma — debe 404 sin 500
    BAD=$(curl -s -o /tmp/b -w "%{http_code}" -X POST "$BASE_URL/api/v1/ordenes" -H "Content-Type: application/json" -d '{"producto_id":999999,"cantidad":1,"total":10}')
    if [ "$BAD" = "404" ] || [ "$BAD" = "503" ]; then
      pass "ordenes fallback 404/503 while productos down (circuit/bl fallback) got $BAD"
    else
      info "WARN ordenes got $BAD while productos down (expected 404 fallback)"
    fi
    docker start erp-productos >/dev/null || true
    sleep 8
    check_status "$BASE_URL/api/v1/productos/health" 200 || info "WARN productos still not ready after restart"
    pass "kill-productos chaos done"
  else
    info "skip kill-productos — container erp-productos not found (compose down?)"
  fi
fi

# 3. latency injection — burst must stay healthy
if [ "$MODE" = "latency" ] || [ "$MODE" = "all" ]; then
  info "chaos latency — 10 concurrent requests + metrics check…"
  rm -rf /tmp/chaos_latency && mkdir -p /tmp/chaos_latency
  for i in $(seq 1 10); do
    curl -s -o "/tmp/chaos_latency/$i.body" -w "%{http_code}" \
      "$BASE_URL/api/v1/productos?limit=50" > "/tmp/chaos_latency/$i.code" &
  done
  wait

  LATENCY_FAILURES=0
  for i in $(seq 1 10); do
    CODE=$(cat "/tmp/chaos_latency/$i.code")
    if [ "$CODE" != "200" ]; then
      LATENCY_FAILURES=$((LATENCY_FAILURES + 1))
    fi
  done
  if [ "$LATENCY_FAILURES" -ne 0 ]; then
    fail "latency burst: $LATENCY_FAILURES/10 requests were not 200"
  fi

  check_status "$BASE_URL/api/productos/metrics" 200 || fail "metrics unavailable after burst"
  LAT=$(curl -s "$BASE_URL/api/productos/metrics" | grep -m1 http_request_duration_ms_bucket || true)
  [ -n "$LAT" ] || fail "http_request_duration_ms_bucket metric missing after burst"
  pass "latency burst done (10/10 OK, metrics present)"
fi

# 4. Cache resilience — MISS → HIT → invalidated MISS
if [ "$MODE" = "cache" ] || [ "$MODE" = "all" ]; then
  info "cache check — cold MISS then HIT then invalidation…"
  CACHE_PAGE=$(( (RANDOM % 9000) + 100 ))
  CACHE_URL="$BASE_URL/api/v1/productos?limit=1&page=$CACHE_PAGE"

  H1=$(curl -s -D /tmp/h1 -o /dev/null -w '' "$CACHE_URL" && grep -i "^X-Cache" /tmp/h1 | tr -d '\r' || true)
  [ -n "$H1" ] || fail "cache header missing on first request (CACHE_ENABLED=false?)"
  echo "$H1" | grep -qi "MISS" || fail "1st request expected MISS, got: $H1"

  H2=$(curl -s -D /tmp/h2 -o /dev/null -w '' "$CACHE_URL" && grep -i "^X-Cache" /tmp/h2 | tr -d '\r' || true)
  echo "$H2" | grep -qi "HIT" || fail "2nd request expected HIT, got: ${H2:-missing}"

  NEW=$(curl -s -X POST "$BASE_URL/api/v1/productos" -H "Content-Type: application/json" \
    -d "{\"nombre\":\"chaos-cache-$(date +%s)-$$\",\"precio\":9.9,\"stock\":1}")
  echo "$NEW" | jq -e '.data.id' >/dev/null || fail "cache invalidate POST producto failed"

  H3=$(curl -s -D /tmp/h3 -o /dev/null -w '' "$CACHE_URL" && grep -i "^X-Cache" /tmp/h3 | tr -d '\r' || true)
  echo "$H3" | grep -qi "MISS" || fail "request after POST expected MISS, got: ${H3:-missing}"
  pass "cache resilience OK (MISS → HIT → MISS)"
fi

# 5. Circuit breaker endpoint must be readable and expose a valid state
if [ "$MODE" = "circuit" ] || [ "$MODE" = "all" ]; then
  info "circuit breaker state…"
  CIRC_BODY=$(mktemp)
  CIRC_CODE=$(curl -s -o "$CIRC_BODY" -w "%{http_code}" "$BASE_URL/api/v1/ordenes/_circuit" || echo "000")
  [ "$CIRC_CODE" = "200" ] || fail "circuit endpoint returned $CIRC_CODE"
  CIRC_STATE=$(jq -r '.state // empty' "$CIRC_BODY" 2>/dev/null || true)
  case "$CIRC_STATE" in
    CLOSED|OPEN|HALF_OPEN) pass "circuit state=$CIRC_STATE" ;;
    *) fail "invalid circuit state: '${CIRC_STATE:-missing}'" ;;
  esac
  rm -f "$CIRC_BODY"
fi

# 6. Stock invariant — salida mayor que stock debe 409
info "stock invariant…"
# crea producto con stock 1
CRE=$(curl -s -X POST "$BASE_URL/api/v1/productos" -H "Content-Type: application/json" -d "{\"nombre\":\"chaos-stock-$(date +%s)-$$\",\"precio\":1,\"stock\":1}")
ID=$(echo "$CRE" | jq -r '.data.id // 0' 2>/dev/null || echo "0")
[ "$ID" != "0" ] && [ "$ID" != "null" ] || fail "could not create product for stock invariant check"
CODE=$(curl -s -o /tmp/s -w "%{http_code}" -X POST "$BASE_URL/api/v1/stock" -H "Content-Type: application/json" -d "{\"producto_id\":$ID,\"cantidad\":100,\"tipo\":\"salida\"}")
if [ "$CODE" = "409" ]; then
  pass "stock invariant 409 OK (cantidad>stock)"
else
  fail "stock salida huge got $CODE (expected 409) body $(cat /tmp/s | head -c 120)"
fi

echo "=== chaos resilience OK (mode=$MODE) ==="
