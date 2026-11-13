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
  queue,
  requireDiagnostics,
  securityMiddleware,
  shutdownTracing,
  trustProxyValue,
} = require('@erp/shared');
const express = require('express');

initTracing(process.env.SERVICE_NAME || 'svc-stock');

const { handleQueueEvent } = require('./consumer');
const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const stockRouter = require('./routes/stock');

assertAuthConfig();

const app = express();
const PORT = process.env.PORT || 3003;

app.set('trust proxy', trustProxyValue());

app.use(securityMiddleware());
app.use(metricsMiddleware);
app.use(express.json());
app.use(auditLog({ pool, logger }));

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

app.get('/metrics', requireDiagnostics, metricsHandler);

app.use('/stock', authenticate, stockRouter);
app.use('/api/stock', authenticate, stockRouter);
app.use('/api/v1/stock', authenticate, stockRouter);

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

  const lifecycle = createLifecycle({
    service: 'svc-stock',
    logger,
    server,
    pool,
    onShutdown: [
      () => outboxRelay?.stop?.(),
      () => queueConsumer?.stop?.(),
      () => shutdownTracing(),
    ],
  });
  lifecycle.install();
}
