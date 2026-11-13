'use strict';

// SPDX-License-Identifier: MIT
// Environment policy — single source of truth for security-sensitive defaults.
//
// The defaults are deliberately different per environment:
//   prod        → auth on, diagnostics off, CORS fail-closed, TLS-ready
//   dev / test  → auth off, diagnostics on, CORS wildcard (developer comfort)
//
// Every reader takes an optional env object so tests can assert the policy
// without mutating global process.env.

function currentEnv(env = process.env) {
  return String(env.NODE_ENV || env.ENVIRONMENT || 'development').toLowerCase();
}

function isProduction(env = process.env) {
  const value = currentEnv(env);
  return value === 'prod' || value === 'production';
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function authEnabled(env = process.env) {
  return parseBoolean(env.AUTH_ENABLED, isProduction(env));
}

function authConfig(env = process.env) {
  return {
    enabled: authEnabled(env),
    secret: env.JWT_SECRET || '',
    // Support PEMs pasted with literal \n escapes (common in .env files).
    publicKey: env.JWT_PUBLIC_KEY ? String(env.JWT_PUBLIC_KEY).replace(/\\n/g, '\n') : '',
  };
}

function diagnosticsEnabled(env = process.env) {
  return parseBoolean(env.ENABLE_DIAGNOSTICS, !isProduction(env));
}

function auditEnabled(env = process.env) {
  return parseBoolean(env.AUDIT_ENABLED, true);
}

function corsAllowedOrigins(env = process.env) {
  return String(env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

/**
 * CORS policy:
 *  - explicit allowlist wins everywhere;
 *  - production without an allowlist fails closed (no Access-Control-Allow-Origin);
 *  - dev/test without an allowlist keeps the historical wildcard.
 */
function corsPolicy(env = process.env) {
  const allowedOrigins = corsAllowedOrigins(env);
  if (allowedOrigins.length > 0) return { mode: 'allowlist', allowedOrigins };
  if (isProduction(env)) return { mode: 'deny', allowedOrigins: [] };
  return { mode: 'wildcard', allowedOrigins: [] };
}

/**
 * Express `trust proxy` setting. Behind ALB → NGINX → service the default of
 * one hop is correct, but deployments differ. TRUST_PROXY accepts:
 *   "false" | "0"      → do not trust proxy headers
 *   "true"             → trust every hop (only for fully trusted networks)
 *   "2"                → trust N hops
 *   "loopback" / CIDRs → forwarded to Express unchanged
 */
function trustProxyValue(env = process.env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === null || raw === '') return 1;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true') return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return raw;
}

module.exports = {
  currentEnv,
  isProduction,
  parseBoolean,
  authEnabled,
  authConfig,
  diagnosticsEnabled,
  auditEnabled,
  corsAllowedOrigins,
  corsPolicy,
  trustProxyValue,
};
