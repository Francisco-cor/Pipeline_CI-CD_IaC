const express = require('express');
const pool = require('./db');
const healthRouter = require('./routes/health');
const stockRouter = require('./routes/stock');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.json({ service: 'svc-stock', version: process.env.APP_VERSION || 'dev', status: 'running' });
});
app.use('/health', healthRouter);
app.use('/stock', stockRouter);

// Graceful shutdown for ECS SIGTERM
// When ECS stops a task (deploy, scale-in, spot interruption), it sends SIGTERM
// first. We finish in-flight requests, close the DB pool, then exit cleanly.
// Without this, abrupt exits can leave DB connections open (exhausting the pool).
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    pool.end(() => process.exit(0));
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`svc-stock listening on port ${PORT}`);
});
