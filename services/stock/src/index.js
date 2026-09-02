'use strict';

const { securityMiddleware, errorHandler, notFoundHandler } = require('@erp/shared');
const express = require('express');

const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const stockRouter = require('./routes/stock');

const app = express();
const PORT = process.env.PORT || 3003;

// Fase 8.3 — trust proxy para rate-limit detrás de NGINX
app.set('trust proxy', 1);

app.use(securityMiddleware());
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
  res.json({ service: 'svc-stock', version: process.env.APP_VERSION || 'dev', status: 'running' });
});

app.use('/health', healthRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/health', healthRouter);

app.use('/stock', stockRouter);
app.use('/api/stock', stockRouter);
app.use('/api/v1/stock', stockRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-stock listening', { port: PORT });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
