'use strict';

// SPDX-License-Identifier: MIT
// Authentication + authorization (JWT bearer, fail-closed in production).
//
// Algorithms:
//   - HS256 with JWT_SECRET (default; suitable for local/dev and single-issuer)
//   - RS256 with JWT_PUBLIC_KEY (recommended when the issuer keeps the private key)
//
// AUTH_ENABLED defaults to true in prod/production and false in dev/test.
// When enabled, a missing signing key is an error: the service refuses to boot
// (`assertAuthConfig`) and, if it is already running, returns 503 instead of
// silently bypassing authentication.

const jwt = require('jsonwebtoken');

const { authConfig, authEnabled } = require('./config');
const { AppError } = require('./errors');

const ROLE_READERS = ['reader', 'operator', 'admin'];
const ROLE_WRITERS = ['operator', 'admin'];
const ROLE_ADMINS = ['admin'];
const VALID_ROLES = new Set(['reader', 'operator', 'admin']);

function authError(code, message) {
  return new AppError(401, code, message);
}

/**
 * Fails fast at startup when auth is on but no verification key exists.
 * Call this once from each service entrypoint; it must not be silently
 * downgraded to "auth off".
 */
function assertAuthConfig(env = process.env) {
  if (!authEnabled(env)) return;
  const { secret, publicKey } = authConfig(env);
  if (!secret && !publicKey) {
    throw new Error(
      'AUTH_ENABLED is on but neither JWT_SECRET (HS256) nor JWT_PUBLIC_KEY (RS256) is configured'
    );
  }
}

function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function normalizeScopes(scopes) {
  if (Array.isArray(scopes)) return scopes.map(String).filter(Boolean);
  if (typeof scopes === 'string') return scopes.split(/\s+/).filter(Boolean);
  return [];
}

function normalizeAuth(payload) {
  const role = String(payload.role || '').toLowerCase();
  if (!VALID_ROLES.has(role)) {
    throw authError('INVALID_TOKEN', 'token is missing a valid role claim');
  }
  return {
    sub: payload.sub !== undefined ? String(payload.sub) : null,
    role,
    tenantId: payload.tenant_id || payload.tenantId || null,
    scopes: normalizeScopes(payload.scopes || payload.scope),
  };
}

function verifyToken(token, env = process.env) {
  const { secret, publicKey } = authConfig(env);
  try {
    if (publicKey) {
      return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    }
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw authError('TOKEN_EXPIRED', 'token has expired');
    }
    throw authError('INVALID_TOKEN', 'token signature or claims are invalid');
  }
}

function authenticate(req, _res, next) {
  if (!authEnabled()) return next();

  const { secret, publicKey } = authConfig();
  if (!secret && !publicKey) {
    return next(
      new AppError(
        503,
        'AUTH_NOT_CONFIGURED',
        'authentication is enabled but no JWT verification key is configured'
      )
    );
  }

  const token = extractBearerToken(req.headers.authorization);
  if (!token) return next(authError('UNAUTHORIZED', 'missing Bearer token'));

  try {
    const payload = verifyToken(token);
    req.auth = normalizeAuth(payload);
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...roles) {
  const allowed = new Set(roles.map(role => String(role).toLowerCase()));
  return (req, _res, next) => {
    if (!authEnabled()) return next();
    if (!req.auth) return next(authError('UNAUTHORIZED', 'authentication required'));
    if (!allowed.has(req.auth.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'insufficient role for this operation'));
    }
    return next();
  };
}

/**
 * Requires at least one of the supplied scopes. Scopes are additive to roles:
 * a role check always runs first when paired with requireRole.
 */
function requireScope(...scopes) {
  const required = scopes.map(String);
  return (req, _res, next) => {
    if (!authEnabled()) return next();
    if (!req.auth) return next(authError('UNAUTHORIZED', 'authentication required'));
    const granted = new Set(req.auth.scopes || []);
    if (!required.some(scope => granted.has(scope))) {
      return next(new AppError(403, 'FORBIDDEN', 'insufficient scope for this operation'));
    }
    return next();
  };
}

module.exports = {
  ROLE_ADMINS,
  ROLE_READERS,
  ROLE_WRITERS,
  ROLE_SCOPES: { read: ROLE_READERS, write: ROLE_WRITERS, delete: ROLE_ADMINS },
  assertAuthConfig,
  authenticate,
  requireRole,
  requireScope,
  verifyToken,
  extractBearerToken,
  normalizeAuth,
};
