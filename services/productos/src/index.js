'use strict';

const {
  assertAuthConfig,
  auditLog,
  authenticate,
  createLifecycle,
  errorHandler,
  initTracing,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  requireDiagnostics,
  securityMiddleware,
  shutdownTracing,
  trustProxyValue,
} = require('@erp/shared');
const express = require('express');

initTracing(process.env.SERVICE_NAME || 'svc-productos');

const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const productosRouter = require('./routes/productos');

// Fail closed at boot when auth is on without a verification key.
assertAuthConfig();

const app = express();
const PORT = process.env.PORT || 3001;

// trust proxy configurable (ALB → NGINX → service); default one hop.
app.set('trust proxy', trustProxyValue());

// Security + compression + requestId (Fase 3.5) + rate-limit (Fase 8.3)
app.use(securityMiddleware());
// Fase 9.3 — metrics (prom-client + EMF) — antes de json parser para capturar todo
app.use(metricsMiddleware);
app.use(express.json());
// Audit mutating requests after auth/request-id are available (best effort).
app.use(auditLog({ pool, logger }));

// Log every request so CloudWatch has method/path/status/duration per entry.
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

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'svc-productos',
    version: process.env.APP_VERSION || 'dev',
    status: 'running',
  });
});

// Health (backward compat + versioned live/ready)
app.use('/health', healthRouter);
// Also mount versioned health for /api/v1 prefix symmetry (Fase 3.2)
app.use('/api/v1/health', healthRouter);
app.use('/api/health', healthRouter);

// Metrics (Fase 9.3) — /metrics expone prom-client, no pasa por paginación/validación
// Gateado: 404 en prod salvo ENABLE_DIAGNOSTICS=true.
app.get('/metrics', requireDiagnostics, metricsHandler);

// Productos — compat + versioned (Fase 3.2). Reads: reader|operator|admin;
// POST/PUT: operator|admin; DELETE: admin (enforced in the router).
app.use('/productos', authenticate, productosRouter);
app.use('/api/productos', authenticate, productosRouter);
app.use('/api/v1/productos', authenticate, productosRouter);

// 404 + central error handler (Fase 3.6)
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-productos listening', { port: PORT });
  });

  const lifecycle = createLifecycle({
    service: 'svc-productos',
    logger,
    server,
    pool,
    onShutdown: [() => shutdownTracing()],
  });
  lifecycle.install();
}
