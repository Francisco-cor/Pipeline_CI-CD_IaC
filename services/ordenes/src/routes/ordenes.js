'use strict';

const {
  AppError,
  CircuitBreaker,
  ROLE_READERS,
  ROLE_WRITERS,
  cache,
  enqueueOrdenCreada,
  enqueueStockActualizado,
  idempotency,
  authenticate,
  parsePagination,
  requireDiagnostics,
  requireRole,
  setPaginationHeaders,
  sortToOrderBy,
  validate,
  ordenSchema,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// Keep the computed total inside ordenes.total NUMERIC(10,2).
const MAX_TOTAL = 99999999.99;

// Defensive no-ops: cache invalidation and rollback failures must not mask the
// real response. Ignored by coverage because they only run on I/O failure.
const ignoreError = /* istanbul ignore next */ () => {};

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

async function fetchProductoHttp(productoId, requestId, authorization) {
  const url = productosFetchUrl(productoId);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const headers = { Accept: 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    // Propagate the caller identity so downstream RBAC sees the same user.
    if (authorization) headers.Authorization = authorization;
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
  (productoId, requestId, authorization) => fetchProductoHttp(productoId, requestId, authorization),
  {
    failureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD) || 5,
    timeout: Number(process.env.CIRCUIT_TIMEOUT_MS) || 10000,
  }
);

async function verifyProductoExists(productoId, requestId, authorization) {
  // Si no hay URL configurada, va directo a DB
  if (!PRODUCTOS_URL) {
    const { rowCount } = await pool.query('SELECT 1 FROM productos WHERE id = $1', [productoId]);
    return rowCount > 0;
  }
  try {
    const result = await breaker.fire(productoId, requestId, authorization);
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
      err.name === 'TypeError' ||
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
router.get('/', authenticate, requireRole(...ROLE_READERS), async (req, res, next) => {
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

// POST /ordenes — server-side total + atomic stock reservation.
//
// Guarantee of the 201: the order row, its `salida` stock movement and the
// outbox events are committed in one transaction, so a 201 means the stock was
// reserved exactly once and the order is `procesada`. SQS/outbox is only the
// downstream integration path; it is not required for stock consistency. If
// SQS is disabled, the order still succeeds and the event stays in the outbox.
router.post(
  '/',
  authenticate,
  requireRole(...ROLE_WRITERS),
  validate(ordenSchema),
  idempotency({ scope: 'ordenes:create', pool }),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { producto_id, cantidad } = req.body;

      // Fast existence check (HTTP with circuit breaker, or DB fallback). The
      // transaction below re-reads and locks the row, so this is not authoritative.
      const exists = await verifyProductoExists(producto_id, req.id, req.headers.authorization);
      if (!exists) {
        throw new AppError(404, 'NOT_FOUND', `producto ${producto_id} not found`);
      }

      await client.query('BEGIN');

      const productResult = await client.query(
        'SELECT id, precio, stock FROM productos WHERE id = $1 FOR UPDATE',
        [producto_id]
      );
      if (productResult.rows.length === 0) {
        throw new AppError(404, 'NOT_FOUND', `producto ${producto_id} not found`);
      }

      const producto = productResult.rows[0];
      if (producto.stock < cantidad) {
        throw new AppError(
          409,
          'STOCK_CONFLICT',
          `stock insuficiente para producto ${producto_id}: stock=${producto.stock} cantidad=${cantidad}`
        );
      }

      // The client-provided total is advisory and ignored: pricing is authoritative.
      const total = Math.round(Number(producto.precio) * cantidad * 100) / 100;
      if (total > MAX_TOTAL) {
        throw new AppError(400, 'VALIDATION_ERROR', 'order total exceeds the supported range');
      }

      const { rows } = await client.query(
        `INSERT INTO ordenes (producto_id, cantidad, total, estado)
       VALUES ($1, $2, $3, 'procesada')
       RETURNING *`,
        [producto_id, cantidad, total]
      );
      const orden = rows[0];

      // The 005 trigger updates productos.stock from this ledger entry. This is
      // the single place where an order reserves stock: the SQS consumer must
      // never insert a second `salida` movement for the same order.
      const movement = await client.query(
        `INSERT INTO movimientos_stock (producto_id, cantidad, tipo)
       VALUES ($1, $2, 'salida')
       RETURNING *`,
        [producto_id, cantidad]
      );

      // The order and its events are committed atomically. SQS delivery is
      // delegated to the durable outbox relay after this transaction commits.
      await enqueueOrdenCreada(client, orden);
      await enqueueStockActualizado(client, movement.rows[0]);
      await client.query('COMMIT');

      cache.del('productos:list:*').catch(ignoreError);
      cache.del(`productos:id:${producto_id}`).catch(ignoreError);

      res.status(201).json({ data: orden });
    } catch (err) {
      await client.query('ROLLBACK').catch(ignoreError);
      next(err);
    } finally {
      client.release();
    }
  }
);

// Debug: breaker stats (diagnostics only; 404 in production)
router.get('/_circuit', requireDiagnostics, (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'not found' });
  res.json(breaker.getStats());
});

// GET /ordenes/:id — single + BFF aggregation ?include=producto (Fase 11.1)
router.get('/:id', authenticate, requireRole(...ROLE_READERS), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'id must be positive integer');
    }
    const { rows } = await pool.query('SELECT * FROM ordenes WHERE id = $1', [id]);
    if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', `orden ${id} not found`);
    const orden = rows[0];

    // BFF aggregation: ?include=producto → fetch producto via HTTP circuit breaker (Fase 10.1) + embed
    const include = String(req.query.include || '').toLowerCase();
    if (include === 'producto' || include === 'product' || include === 'true') {
      try {
        const fetched = await breaker.fire(orden.producto_id, req.id, req.headers.authorization);
        // fetched = { exists, data } o null si no PRODUCTOS_URL
        if (fetched && fetched.exists) {
          return res.json({
            data: orden,
            producto: fetched.data,
            _bff: 'orden+producto aggregated',
          });
        }
        if (fetched && !fetched.exists) {
          return res.json({
            data: orden,
            producto: null,
            warning: `producto ${orden.producto_id} not found`,
          });
        }
        // fallback sin PRODUCTOS_URL → DB direct
        const { rows: prodRows } = await pool.query('SELECT * FROM productos WHERE id = $1', [
          orden.producto_id,
        ]);
        return res.json({
          data: orden,
          producto: prodRows[0] || null,
          _bff: 'orden+producto aggregated (db fallback)',
        });
      } catch (bffErr) {
        // Si circuit OPEN o fetch fails, degradar sin producto pero no 500
        const logger = require('../logger');
        logger.warn('bff_include_producto_failed', {
          orden_id: id,
          producto_id: orden.producto_id,
          error: bffErr.message,
          state: breaker.getState(),
        });
        return res.json({
          data: orden,
          producto: null,
          warning: 'producto fetch failed, circuit fallback',
          _bff: 'degraded',
        });
      }
    }

    res.json({ data: orden });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
