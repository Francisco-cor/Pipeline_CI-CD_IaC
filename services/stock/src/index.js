'use strict';

const {
  errorHandler,
  initTracing,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  queue,
  securityMiddleware,
} = require('@erp/shared');
const express = require('express');

initTracing(process.env.SERVICE_NAME || 'svc-stock');

const { handleQueueEvent } = require('./consumer');
const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const stockRouter = require('./routes/stock');

const app = express();
const PORT = process.env.PORT || 3003;

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
  res.json({ service: 'svc-stock', version: process.env.APP_VERSION || 'dev', status: 'running' });
});

app.use('/health', healthRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/health', healthRouter);

app.get('/metrics', metricsHandler);

app.use('/stock', stockRouter);
app.use('/api/stock', stockRouter);
app.use('/api/v1/stock', stockRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// With SQS configured, the stock task both relays committed outbox rows and
// consumes events. The inbox transaction makes redeliveries idempotent.
const outboxRelay = queue.startOutboxRelay(pool);
const queueConsumer = queue.startConsumer(handleQueueEvent, { pool });

module.exports = app;

/* istanbul ignore next -- exercised by the container entrypoint, not supertest */
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('svc-stock listening', { port: PORT });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    outboxRelay?.stop();
    queueConsumer?.stop();
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
