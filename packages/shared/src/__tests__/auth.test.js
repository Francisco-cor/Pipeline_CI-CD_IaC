'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { assertAuthConfig, authenticate, requireRole, requireScope } = require('../auth');
const {
  authConfig,
  authEnabled,
  corsPolicy,
  diagnosticsEnabled,
  trustProxyValue,
} = require('../config');
const { errorHandler } = require('../errors');

const SECRET = 'test-jwt-secret';

function token(overrides = {}, options = {}) {
  return jwt.sign(
    {
      sub: 'user-1',
      role: 'reader',
      tenant_id: 'tenant-a',
      scopes: ['productos:read'],
      ...overrides,
    },
    SECRET,
    { expiresIn: '1h', ...options }
  );
}

function buildApp() {
  const app = express();
  app.get('/secure', authenticate, requireRole('reader', 'operator', 'admin'), (req, res) => {
    res.json({ auth: req.auth });
  });
  app.post('/write', authenticate, requireRole('operator', 'admin'), (req, res) => {
    res.status(201).json({ auth: req.auth });
  });
  app.get('/scoped', authenticate, requireScope('productos:write'), (req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('environment policy defaults', () => {
  it('enables auth and disables diagnostics in production', () => {
    const env = { NODE_ENV: 'prod' };
    expect(authEnabled(env)).toBe(true);
    expect(diagnosticsEnabled(env)).toBe(false);
    expect(corsPolicy(env)).toEqual({ mode: 'deny', allowedOrigins: [] });
  });

  it('keeps developer defaults in test/dev', () => {
    const env = { NODE_ENV: 'test' };
    expect(authEnabled(env)).toBe(false);
    expect(diagnosticsEnabled(env)).toBe(true);
    expect(corsPolicy(env)).toEqual({ mode: 'wildcard', allowedOrigins: [] });
  });

  it('honours explicit toggles and allowlists', () => {
    expect(authEnabled({ NODE_ENV: 'test', AUTH_ENABLED: 'true' })).toBe(true);
    expect(authEnabled({ NODE_ENV: 'prod', AUTH_ENABLED: 'false' })).toBe(false);
    expect(diagnosticsEnabled({ NODE_ENV: 'prod', ENABLE_DIAGNOSTICS: 'true' })).toBe(true);
    expect(corsPolicy({ NODE_ENV: 'prod', CORS_ORIGIN: 'https://a.test, https://b.test' })).toEqual(
      { mode: 'allowlist', allowedOrigins: ['https://a.test', 'https://b.test'] }
    );
  });

  it('parses trust proxy values without trusting arbitrary input by default', () => {
    expect(trustProxyValue({})).toBe(1);
    expect(trustProxyValue({ TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxyValue({ TRUST_PROXY: 'false' })).toBe(false);
    expect(trustProxyValue({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe('loopback, 10.0.0.0/8');
  });
});

describe('JWT authentication', () => {
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_ENABLED = 'true';
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_PUBLIC_KEY;
  });

  afterAll(() => {
    process.env = previous;
  });

  it('rejects a request without a Bearer token', async () => {
    const res = await request(buildApp()).get('/secure');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a valid token and attaches sub/role/tenant/scopes', async () => {
    const res = await request(buildApp()).get('/secure').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({
      sub: 'user-1',
      role: 'reader',
      tenantId: 'tenant-a',
      scopes: ['productos:read'],
    });
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ sub: 'u', role: 'reader' }, SECRET, { expiresIn: -1 });
    const res = await request(buildApp()).get('/secure').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ sub: 'u', role: 'admin' }, 'other-secret');
    const res = await request(buildApp()).get('/secure').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token without a valid role', async () => {
    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', `Bearer ${token({ role: 'superuser' })}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 when the role is insufficient', async () => {
    const res = await request(buildApp())
      .post('/write')
      .set('Authorization', `Bearer ${token({ role: 'reader' })}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows writes for operator/admin roles', async () => {
    const res = await request(buildApp())
      .post('/write')
      .set('Authorization', `Bearer ${token({ role: 'operator' })}`);
    expect(res.status).toBe(201);
  });

  it('enforces scopes independently of roles', async () => {
    const denied = await request(buildApp())
      .get('/scoped')
      .set('Authorization', `Bearer ${token()}`);
    expect(denied.status).toBe(403);

    const allowed = await request(buildApp())
      .get('/scoped')
      .set('Authorization', `Bearer ${token({ scopes: ['productos:write'] })}`);
    expect(allowed.status).toBe(200);
  });

  it('fails closed when auth is enabled without a verification key', async () => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_PUBLIC_KEY;
    expect(() => assertAuthConfig()).toThrow(/JWT_SECRET|JWT_PUBLIC_KEY/);

    const res = await request(buildApp()).get('/secure').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('bypasses authentication when disabled in dev/test', async () => {
    process.env.AUTH_ENABLED = 'false';
    expect(authConfig().enabled).toBe(false);
    const res = await request(buildApp()).get('/secure');
    expect(res.status).toBe(200);
  });
});

describe('RS256 support', () => {
  it('verifies RS256 tokens when JWT_PUBLIC_KEY is configured', async () => {
    const { generateKeyPairSync } = require('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const previous = { ...process.env };
    process.env.AUTH_ENABLED = 'true';
    process.env.JWT_PUBLIC_KEY = publicKey;
    delete process.env.JWT_SECRET;

    try {
      const rsToken = jwt.sign({ sub: 'rsa-user', role: 'admin' }, privateKey, {
        algorithm: 'RS256',
        expiresIn: '1h',
      });
      const res = await request(buildApp())
        .get('/secure')
        .set('Authorization', `Bearer ${rsToken}`);
      expect(res.status).toBe(200);
      expect(res.body.auth.sub).toBe('rsa-user');
    } finally {
      process.env = previous;
    }
  });
});
