'use strict';

const express = require('express');
const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const productosRouter = require('./routes/productos');

const app = express();
const PORT = process.env.PORT || 3001;

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
    });
  });
  next();
});

// Routes
app.get('/', (req, res) => {
  res.json({ service: 'svc-productos', version: process.env.APP_VERSION || 'dev', status: 'running' });
});
app.use('/health', healthRouter);
app.use('/productos', productosRouter);

// Export app for supertest — module.exports must come before listen so test
// imports resolve without side effects (no port binding in tests).
module.exports = app;

// Only start the server when run directly, not when required by Jest.
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`svc-productos listening`, { port: PORT });
  });

  // Graceful shutdown for ECS SIGTERM
  // When ECS stops a task (deploy, scale-in, spot interruption), it sends SIGTERM
  // first. We finish in-flight requests, close the DB pool, then exit cleanly.
  // Without this, abrupt exits can leave DB connections open (exhausting the pool).
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
