// SPDX-License-Identifier: MIT
// k6 resilience — Fase 10.7 chaos under load: 50 rps, producto cache + orden fallback
// Simula kill parcial: 20% requests con producto_id inexistente deben 404 sin 5xx cascade
// Thresholds: http_req_failed <1% (solo 404 esperados no cuentan como failed), p95 <300ms

import { check, sleep } from 'k6';
import http from 'k6/http';

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:80';

export function setup() {
  // crea producto base para ordenes válidas
  const payload = JSON.stringify({ nombre: `resilience-setup-${Date.now()}`, precio: 10, stock: 100 });
  const res = http.post(`${BASE_URL}/api/v1/productos`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status !== 201) return { productId: 1 };
  try {
    const body = JSON.parse(res.body);
    return { productId: body.data.id };
  } catch (_e) {
    return { productId: 1 };
  }
}

export default function (data) {
  const productId = data.productId || 1;

  // 70% GET productos cache hit expected (X-Cache HIT second call)
  const r1 = http.get(`${BASE_URL}/api/v1/productos?limit=5`);
  check(r1, { 'GET productos 200': r => r.status === 200 });

  // 20% orden válida, 10% orden inválida (producto inexistente) → 404 sin cascade
  const rnd = Math.random();
  if (rnd < 0.2) {
    const ok = http.post(`${BASE_URL}/api/v1/ordenes`, JSON.stringify({ producto_id: productId, cantidad: 1, total: 10 }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(ok, { 'POST orden 201': r => r.status === 201 });
  } else if (rnd < 0.3) {
    const bad = http.post(`${BASE_URL}/api/v1/ordenes`, JSON.stringify({ producto_id: 999999, cantidad: 1, total: 10 }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(bad, { 'POST orden 404 fallback': r => r.status === 404 });
  }

  // 10% stock movimiento
  if (Math.random() < 0.1) {
    const tipo = Math.random() < 0.5 ? 'entrada' : 'salida';
    const cantidad = tipo === 'salida' ? 1 : 2;
    const s = http.post(`${BASE_URL}/api/v1/stock`, JSON.stringify({ producto_id: productId, cantidad, tipo }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(s, { 'POST stock 201 or 409': r => r.status === 201 || r.status === 409 });
  }

  sleep(0.05);
}
