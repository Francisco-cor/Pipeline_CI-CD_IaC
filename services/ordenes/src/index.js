'use strict';

const express = require('express');
const pool = require('./db');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const ordenesRouter = require('./routes/ordenes');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.json({ service: 'svc-ordenes', version: process.env.APP_VERSION || 'dev', status: 'running' });
});
app.use('/health', healthRouter);
app.use('/ordenes', ordenesRouter);

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`svc-ordenes listening`, { port: PORT });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    server.close(() => {
      pool.end(() => process.exit(0));
    });
  });
}
