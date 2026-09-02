// SPDX-License-Identifier: MIT
// k6 smoke — 30 RPS, 30s, p95 <500ms, error <1%
// Uso: k6 run scripts/k6/smoke.js  (o docker run grafana/k6 run /scripts/k6/smoke.js)
// BASE_URL env: http://localhost:80 (compose) o ECS public IP

import { check, sleep } from 'k6';
import http from 'k6/http';

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '20s', target: 30 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:80';

export default function () {
  // Mix de lecturas (90%) y escrituras (10%)
  const reads = [
    `${BASE_URL}/health`,
    `${BASE_URL}/api/v1/productos?limit=5`,
    `${BASE_URL}/api/v1/productos/health`,
    `${BASE_URL}/api/v1/ordenes?limit=3`,
    `${BASE_URL}/api/v1/stock?limit=3`,
  ];

  const url = reads[Math.floor(Math.random() * reads.length)];
  const res = http.get(url);
  check(res, {
    'status 200': r => r.status === 200,
    'has X-Request-Id': r => !!r.headers['X-Request-Id'],
  });

  // 10% writes a productos
  if (Math.random() < 0.1) {
    const payload = JSON.stringify({
      nombre: `k6-${Math.random().toString(36).slice(2, 8)}`,
      precio: Math.random() * 100,
      stock: Math.floor(Math.random() * 10),
    });
    const w = http.post(`${BASE_URL}/api/v1/productos`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    check(w, { 'POST 201': r => r.status === 201 });
  }

  sleep(0.1);
}
