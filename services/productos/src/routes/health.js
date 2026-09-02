'use strict';

const express = require('express');

const pool = require('../db');
const logger = require('../logger');

const router = express.Router();

// GET /health — readiness (DB check) — ECS uses this
router.get('/', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'svc-productos',
      db: 'connected',
      latency_ms: Date.now() - start,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (err) {
    logger.error('Health check failed — DB unreachable', { error: err.message, requestId: req.id });
    res.status(500).json({
      status: 'error',
      service: process.env.SERVICE_NAME || 'svc-productos',
      db: 'disconnected',
    });
  }
});

// GET /health/live — liveness (no DB) — Fase 3.8
router.get('/live', (req, res) => {
  res.json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'svc-productos',
    uptime_s: Math.floor(process.uptime()),
  });
});

// GET /health/ready — alias to /health (readiness)
router.get('/ready', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'svc-productos',
      db: 'connected',
      latency_ms: Date.now() - start,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (err) {
    logger.error('Health ready failed', { error: err.message, requestId: req.id });
    res.status(500).json({
      status: 'error',
      service: process.env.SERVICE_NAME || 'svc-productos',
      db: 'disconnected',
    });
  }
});

module.exports = router;
