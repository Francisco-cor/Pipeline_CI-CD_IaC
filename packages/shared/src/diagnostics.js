'use strict';

// SPDX-License-Identifier: MIT
// Diagnostics gate — /metrics, /health/details, /_circuit and /bff/health
// expose internal state and must not be reachable from the public edge in
// production. ENABLE_DIAGNOSTICS defaults to true in dev/test and false in
// prod. Returning 404 (instead of 403) keeps the surface invisible.

const { diagnosticsEnabled } = require('./config');

function notFoundBody() {
  return { error: { code: 'NOT_FOUND', message: 'route not found' } };
}

function requireDiagnostics(req, res, next) {
  if (diagnosticsEnabled()) return next();
  return res.status(404).json(notFoundBody());
}

module.exports = { requireDiagnostics, notFoundBody };
