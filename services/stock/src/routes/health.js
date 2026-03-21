const express = require('express');
const pool = require('../db');
const logger = require('../logger');

const router = express.Router();

// GET /health
// Returns 200 if the service is up AND the DB connection works.
// ECS health check calls this. If this returns non-200, ECS marks the
// container unhealthy and the deployment circuit breaker fires after 3 failures.
router.get('/', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'unknown',
      db: 'connected',
      latency_ms: Date.now() - start,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (err) {
    // Return 500 — this is what triggers ECS rollback
    logger.error('Health check failed — DB unreachable', { error: err.message });
    res.status(500).json({
      status: 'error',
      service: process.env.SERVICE_NAME || 'unknown',
      db: 'disconnected',
      error: err.message,
    });
  }
});

module.exports = router;
