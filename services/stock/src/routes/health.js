'use strict';

const express = require('express');

const pool = require('../db');
const logger = require('../logger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'svc-stock',
      db: 'connected',
      latency_ms: Date.now() - start,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (err) {
    logger.error('Health check failed — DB unreachable', { error: err.message, requestId: req.id });
    res.status(500).json({
      status: 'error',
      service: process.env.SERVICE_NAME || 'svc-stock',
      db: 'disconnected',
    });
  }
});

router.get('/live', (req, res) => {
  res.json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'svc-stock',
    uptime_s: Math.floor(process.uptime()),
  });
});

router.get('/ready', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'svc-stock',
      db: 'connected',
      latency_ms: Date.now() - start,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (err) {
    logger.error('Health ready failed', { error: err.message, requestId: req.id });
    res.status(500).json({
      status: 'error',
      service: process.env.SERVICE_NAME || 'svc-stock',
      db: 'disconnected',
    });
  }
});

router.get('/details', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'unknown';
  let latencyMs;
  try {
    await pool.query('SELECT 1');
    latencyMs = Date.now() - start;
    dbStatus = 'connected';
  } catch (err) {
    latencyMs = Date.now() - start;
    dbStatus = 'disconnected';
  }
  const poolStats = {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
  res.json({
    status: dbStatus === 'connected' ? 'ok' : 'error',
    service: process.env.SERVICE_NAME || 'svc-stock',
    db: dbStatus,
    latency_ms: latencyMs,
    uptime_s: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    pool: poolStats,
    version: process.env.APP_VERSION || 'dev',
    requestId: req.id,
  });
});

module.exports = router;
