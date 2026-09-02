'use strict';

const {
  CircuitBreaker,
  errorHandler,
  initTracing,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  securityMiddleware,
} = require('@erp/shared');
const express = require('express');
const pool = require('./db');
const logger = require('./logger');

initTracing(process.env.SERVICE_NAME || 'svc-gateway');

const app = express();
const PORT = process.env.PORT || 3004;

app.set('trust proxy', 1);
app.use(securityMiddleware());
app.use(metricsMiddleware);
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http_request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      requestId: req.id,
    });
  });
  next();
});

app.get('/', (req, res) => {
  res.json({
    service: 'svc-gateway',
    version: process.env.APP_VERSION || 'dev',
    status: 'running',
  });
});

const healthRouter = require('./routes/health');
app.use('/health', healthRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/health', healthRouter);
app.get('/metrics', metricsHandler);

// BFF aggregation — GET /bff/ordenes/:id?include=producto (proxy aggregation)
const ORDENES_URL = process.env.ORDENES_URL || 'http://ordenes:3002';
const PRODUCTOS_URL = process.env.PRODUCTOS_URL || 'http://productos:3001';

const breakerOrden = new CircuitBreaker(
  async (id, requestId) => {
    const url = `${ORDENES_URL.replace(/\/$/, '')}/ordenes/${id}`;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    try {
      const h = { Accept: 'application/json' };
      if (requestId) h['X-Request-Id'] = requestId;
      const r = await fetch(url, { signal: c.signal, headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`ordenes HTTP ${r.status}`);
      const b = await r.json();
      return b.data || b;
    } finally {
      clearTimeout(t);
    }
  },
  { failureThreshold: 5, timeout: 10000 }
);

const breakerProd = new CircuitBreaker(
  async (id, requestId) => {
    const url = `${PRODUCTOS_URL.replace(/\/$/, '')}/productos/${id}`;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    try {
      const h = { Accept: 'application/json' };
      if (requestId) h['X-Request-Id'] = requestId;
      const r = await fetch(url, { signal: c.signal, headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`productos HTTP ${r.status}`);
      const b = await r.json();
      return b.data || b;
    } finally {
      clearTimeout(t);
    }
  },
  { failureThreshold: 5, timeout: 10000 }
);

app.get('/bff/ordenes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'id must be positive integer' } });
    const orden = await breakerOrden.fire(id, req.id);
    if (!orden)
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: `orden ${id} not found` } });

    // include producto by default for BFF
    const include = String(req.query.include || 'producto').toLowerCase();
    let producto = null;
    let productoError = null;
    if (include === 'producto' || include === 'true') {
      try {
        producto = await breakerProd.fire(orden.producto_id, req.id);
      } catch (e) {
        productoError = e.message;
        logger.warn('bff_producto_fetch_failed', { orden_id: id, error: e.message });
      }
    }

    res.json({
      data: orden,
      producto,
      ...(productoError ? { warning: productoError } : {}),
      _bff: 'gateway aggregated',
    });
  } catch (err) {
    next(err);
  }
});

// Also expose gateway health pool (reuse db)
app.get('/bff/health', async (req, res) => {
  res.json({
    status: 'ok',
    service: 'svc-gateway',
    bff: 'ordenes+productos',
    ordenesUrl: ORDENES_URL,
    productosUrl: PRODUCTOS_URL,
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-gateway listening', { port: PORT });
  });
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing gateway');
    server.close(() => {
      try {
        pool.end(() => process.exit(0));
      } catch (_e) {
        process.exit(0);
      }
    });
  });
}
