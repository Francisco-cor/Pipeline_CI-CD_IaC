'use strict';

// SPDX-License-Identifier: MIT
// Shared middlewares — Fase 3.5 (security + requestId) + Fase 8.3 rate-limit

const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');

const { storage } = require('./logger');

function requestIdMiddleware(req, _res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuidv4();
  req.id = id;
  // Fase 9.1 — guarda en AsyncLocalStorage para que logger lo incluya automáticamente
  storage.enterWith({ requestId: id });
  // expose to response (también lo hace securityMiddleware, pero lo dejamos aquí para standalone use)
  req.headers['x-request-id'] = id;
  next();
}

// Fase 8.3 — rate limit per-service (defensa en profundidad además de NGINX limit_req_zone 30r/s)
// 100 req/min por IP por defecto, configurable via RATE_LIMIT_MAX env
function createRateLimiter() {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
  const max = Number(process.env.RATE_LIMIT_MAX) || 100;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    // trustProxy se configura en app.set('trust proxy', 1) en index.js
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
          requestId: req.id,
        },
      });
    },
  });
}

function securityMiddleware() {
  return [
    helmet({
      contentSecurityPolicy: false, // API-only, no CSP needed
      crossOriginEmbedderPolicy: false,
    }),
    cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: false,
    }),
    compression(),
    requestIdMiddleware,
    // expose requestId header
    (req, res, next) => {
      res.setHeader('X-Request-Id', req.id);
      next();
    },
    createRateLimiter(),
  ];
}

module.exports = { securityMiddleware, requestIdMiddleware, createRateLimiter };
