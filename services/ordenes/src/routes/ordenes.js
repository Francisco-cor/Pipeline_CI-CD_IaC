'use strict';

const {
  AppError,
  CircuitBreaker,
  parsePagination,
  publishOrdenCreada,
  setPaginationHeaders,
  sortToOrderBy,
  validate,
  ordenSchema,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// Fase 10.1 — decouples ordenes → productos via HTTP + circuit breaker
// Cuando PRODUCTOS_URL está seteado (ej. http://productos.erp.local:3001 o http://productos:3001)
// intenta verificar via HTTP; si falla o circuit OPEN, hace fallback a SELECT directo (bounded context legacy).
// En compose sin service discovery, PRODUCTOS_URL no se setea → usa DB directo (compat para tests).
const PRODUCTOS_URL =
  process.env.PRODUCTOS_URL ||
  (process.env.ENABLE_SERVICE_DISCOVERY === 'true' ? 'http://productos.erp.local:3001' : null);

function productosFetchUrl(productoId) {
  if (!PRODUCTOS_URL) return null;
  // productos service expone GET /productos/:id y /api/v1/productos/:id; usamos raíz
  const base = PRODUCTOS_URL.replace(/\/$/, '');
  // Si base ya incluye /productos, no duplicar
  if (
    base.endsWith('/productos') ||
    base.endsWith('/api/productos') ||
    base.endsWith('/api/v1/productos')
  ) {
    return `${base}/${productoId}`;
  }
  return `${base}/productos/${productoId}`;
}

async function fetchProductoHttp(productoId, requestId) {
  const url = productosFetchUrl(productoId);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const headers = { Accept: 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`productos HTTP ${res.status}`);
    const body = await res.json();
    // Soporta { data: {...} } o directo
    const data = body.data || body;
    if (!data || !data.id) return { exists: false };
    return { exists: true, data };
  } finally {
    clearTimeout(timeout);
  }
}

const breaker = new CircuitBreaker(
  (productoId, requestId) => fetchProductoHttp(productoId, requestId),
  {
    failureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD) || 5,
    timeout: Number(process.env.CIRCUIT_TIMEOUT_MS) || 10000,
  }
);

async function verifyProductoExists(productoId, requestId) {
  // Si no hay URL configurada, va directo a DB
  if (!PRODUCTOS_URL) {
    const { rowCount } = await pool.query('SELECT 1 FROM productos WHERE id = $1', [productoId]);
    return rowCount > 0;
  }
  try {
    const result = await breaker.fire(productoId, requestId);
    if (result === null) {
      // breaker no ejecutó por falta de URL — fallback (ya manejado arriba)
      const { rowCount } = await pool.query('SELECT 1 FROM productos WHERE id = $1', [productoId]);
      return rowCount > 0;
    }
    return result.exists;
  } catch (err) {
    // Circuit OPEN o error de red → fallback a DB para resiliencia
    if (
      err.code === 'CIRCUIT_OPEN' ||
      err.name === 'AbortError' ||
      err.message.includes('productos HTTP')
    ) {
      const logger = require('../logger');
      logger.warn('productos_http_fallback_to_db', {
        producto_id: productoId,
        error: err.message,
        state: breaker.getState(),
      });
      const { rowCount } = await pool.query('SELECT 1 FROM productos WHERE id = $1', [productoId]);
      return rowCount > 0;
    }
    throw err;
  }
}

// GET /ordenes — paginated
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset, sort } = parsePagination(req);
    const orderBy = sortToOrderBy(sort);

    const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM ordenes');
    const total = totalResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT * FROM ordenes ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    setPaginationHeaders(res, req, page, limit, total);

    res.json({ data: rows, count: rows.length, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// POST /ordenes — zod + FK check (Fase 10.1 HTTP + circuit breaker) + SQS outbox (10.6)
router.post('/', validate(ordenSchema), async (req, res, next) => {
  try {
    const { producto_id, cantidad, total } = req.body;

    const exists = await verifyProductoExists(producto_id, req.id);
    if (!exists) {
      throw new AppError(404, 'NOT_FOUND', `producto ${producto_id} not found`);
    }

    const { rows } = await pool.query(
      'INSERT INTO ordenes (producto_id, cantidad, total) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, total]
    );
    const orden = rows[0];

    // Fase 10.6 — publica orden.creada best-effort (no bloquea respuesta si SQS no configurado)
    publishOrdenCreada(orden).catch(() => {});

    res.status(201).json({ data: orden });
  } catch (err) {
    next(err);
  }
});

// Debug: breaker stats (solo dev)
router.get('/_circuit', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'not found' });
  res.json(breaker.getStats());
});

module.exports = router;
