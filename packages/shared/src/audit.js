'use strict';

// SPDX-License-Identifier: MIT
// Audit log for state-changing requests.
//
// The middleware is best-effort: a failed INSERT is logged as a warning and
// never changes the response the client already received. The request itself
// must not fail because the audit table is temporarily unavailable.
//
// The row is written on `res.finish`, so `req.auth` and `req.id` are already
// populated by the authentication/request-id middlewares.

const { auditEnabled } = require('./config');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function deriveResource(pathname) {
  const segments = String(pathname || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .filter(segment => segment !== 'api' && !/^v\d+$/i.test(segment));

  const resource = segments[0] || 'unknown';
  const candidate = segments.length > 1 ? segments[segments.length - 1] : null;
  return { resource, resourceId: candidate };
}

function auditAction(method, resource) {
  return `${String(method).toLowerCase()}:${resource}`;
}

async function insertAuditRow(pool, req, res) {
  const auth = req.auth || {};
  const pathname = req.originalUrl || req.path || '';
  const { resource, resourceId } = deriveResource(pathname.split('?')[0]);
  const id = req.params && req.params.id !== undefined ? req.params.id : resourceId;

  await pool.query(
    `INSERT INTO audit_log
       (actor_sub, actor_role, tenant_id, action, resource, resource_id, status, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      auth.sub || null,
      auth.role || null,
      auth.tenantId || null,
      auditAction(req.method, resource),
      resource,
      id !== null && id !== undefined ? String(id) : null,
      res.statusCode,
      req.id || null,
      JSON.stringify({
        method: req.method,
        path: pathname,
      }),
    ]
  );
}

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {object} [opts.logger] structured logger (defaults to shared logger)
 */
function auditLog(opts = {}) {
  const pool = opts.pool;
  const logger = opts.logger || require('./logger');

  return (req, res, next) => {
    if (!auditEnabled() || !MUTATING_METHODS.has(req.method)) return next();

    res.on('finish', () => {
      if (!pool || typeof pool.query !== 'function') return;
      insertAuditRow(pool, req, res).catch(err => {
        logger.warn('audit_write_failed', {
          error: err && err.message,
          method: req.method,
          path: req.originalUrl || req.path,
          requestId: req.id,
        });
      });
    });

    return next();
  };
}

module.exports = { auditLog, insertAuditRow, deriveResource, auditAction, MUTATING_METHODS };
