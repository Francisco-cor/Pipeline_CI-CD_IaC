'use strict';

const {
  errorHandler,
  initTracing,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  securityMiddleware,
} = require('@erp/shared');
const express = require('express');

initTracing(process.env.SERVICE_NAME || 'svc-ordenes');

const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const ordenesRouter = require('./routes/ordenes');

const app = express();
const PORT = process.env.PORT || 3002;

// Fase 8.3 — trust proxy para rate-limit detrás de NGINX
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
    service: 'svc-ordenes',
    version: process.env.APP_VERSION || 'dev',
    status: 'running',
  });
});

app.use('/health', healthRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/health', healthRouter);

app.get('/metrics', metricsHandler);

app.use('/ordenes', ordenesRouter);
app.use('/api/ordenes', ordenesRouter);
app.use('/api/v1/ordenes', ordenesRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-ordenes listening', { port: PORT });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
