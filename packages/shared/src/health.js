'use strict';

// SPDX-License-Identifier: MIT
// Shared health router: /health/live is liveness (no dependencies),
// /health and /health/ready are readiness (DB + optional critical deps).
// /health stays as a backwards-compatible readiness alias.

const express = require('express');

const { diagnosticsEnabled } = require('./config');
const { isDraining } = require('./lifecycle');

function createHealthRouter(opts = {}) {
  const service = opts.serviceName || process.env.SERVICE_NAME || 'service';
  const pool = opts.pool;
  const logger = opts.logger || require('./logger');
  const dependencies = opts.dependencies || [];
  const router = express.Router();

  function uptime() {
    return Math.floor(process.uptime());
  }

  async function checkReadiness() {
    const start = Date.now();
    const checks = {};

    try {
      await pool.query('SELECT 1');
      checks.db = 'connected';
    } catch (err) {
      checks.db = 'disconnected';
      return { ok: false, checks, error: err, latency_ms: Date.now() - start };
    }

    for (const dependency of dependencies) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await dependency.check();
        checks[dependency.name] = result === false ? 'unavailable' : 'ok';
        if (result === false) {
          return { ok: false, checks, latency_ms: Date.now() - start };
        }
      } catch (err) {
        checks[dependency.name] = 'unavailable';
        return { ok: false, checks, error: err, latency_ms: Date.now() - start };
      }
    }

    return { ok: true, checks, latency_ms: Date.now() - start };
  }

  async function readyHandler(req, res) {
    if (isDraining()) {
      return res.status(503).json({
        status: 'draining',
        service,
        uptime_s: uptime(),
      });
    }

    const result = await checkReadiness();
    if (!result.ok) {
      logger.error('Health check failed', {
        error: result.error && result.error.message,
        checks: result.checks,
        requestId: req.id,
      });
      return res.status(500).json({
        status: 'error',
        service,
        db: result.checks.db,
        checks: result.checks,
      });
    }

    return res.json({
      status: 'ok',
      service,
      db: 'connected',
      checks: result.checks,
      latency_ms: result.latency_ms,
      uptime_s: uptime(),
    });
  }

  // Readiness (legacy path) and explicit readiness.
  router.get('/', readyHandler);
  router.get('/ready', readyHandler);

  // Liveness: process is up; must never touch the DB.
  router.get('/live', (req, res) => {
    res.json({
      status: 'ok',
      service,
      uptime_s: uptime(),
    });
  });

  router.get('/details', async (req, res) => {
    // Pool stats, memory and draining state are operational diagnostics, not
    // readiness. In production ENABLE_DIAGNOSTICS defaults to false and the
    // route must be indistinguishable from a missing route.
    if (!diagnosticsEnabled()) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    }
    const start = Date.now();
    let dbStatus = 'unknown';
    let latencyMs;
    try {
      await pool.query('SELECT 1');
      latencyMs = Date.now() - start;
      dbStatus = 'connected';
    } catch (_err) {
      latencyMs = Date.now() - start;
      dbStatus = 'disconnected';
    }
    res.json({
      status: dbStatus === 'connected' && !isDraining() ? 'ok' : 'error',
      service,
      db: dbStatus,
      draining: isDraining(),
      latency_ms: latencyMs,
      uptime_s: uptime(),
      memory: process.memoryUsage(),
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
      version: process.env.APP_VERSION || 'dev',
      requestId: req.id,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
