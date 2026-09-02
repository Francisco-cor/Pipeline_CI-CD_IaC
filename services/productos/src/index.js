'use strict';

const { securityMiddleware, errorHandler, notFoundHandler } = require('@erp/shared');
const express = require('express');

const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const productosRouter = require('./routes/productos');

const app = express();
const PORT = process.env.PORT || 3001;

// Fase 8.3 — trust proxy para rate-limit detrás de NGINX + security headers
app.set('trust proxy', 1);

// Security + compression + requestId (Fase 3.5) + rate-limit (Fase 8.3)
app.use(securityMiddleware());
app.use(express.json());

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

// Productos — compat + versioned (Fase 3.2)
app.use('/productos', productosRouter);
app.use('/api/productos', productosRouter);
app.use('/api/v1/productos', productosRouter);

// 404 + central error handler (Fase 3.6)
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-productos listening', { port: PORT });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
