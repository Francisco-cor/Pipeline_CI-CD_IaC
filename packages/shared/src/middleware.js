'use strict';

// SPDX-License-Identifier: MIT
// Shared middlewares — Fase 3.5 (security + requestId)

const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');

function requestIdMiddleware(req, _res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuidv4();
  req.id = id;
  // expose to response
  req.headers['x-request-id'] = id;
  next();
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
  ];
}

module.exports = { securityMiddleware, requestIdMiddleware };
