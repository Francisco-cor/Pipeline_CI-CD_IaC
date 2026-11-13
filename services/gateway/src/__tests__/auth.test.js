'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../index');

const SECRET = 'gateway-jwt-secret';
const sign = (role, sub = 'gw-user') =>
  jwt.sign({ sub, role, tenant_id: 'gw-tenant' }, SECRET, { expiresIn: '1h' });

describe('Gateway — auth and diagnostics gates', () => {
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_ENABLED = 'true';
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_PUBLIC_KEY;
  });

  afterAll(() => {
    process.env = previous;
  });

  it('requires a token for BFF reads', async () => {
    const res = await request(app).get('/bff/ordenes/not-an-id');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('reaches validation with a valid reader token', async () => {
    const res = await request(app)
      .get('/bff/ordenes/not-an-id')
      .set('Authorization', `Bearer ${sign('reader')}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a token without a valid role', async () => {
    const res = await request(app)
      .get('/bff/ordenes/not-an-id')
      .set('Authorization', `Bearer ${sign('auditor')}`);
    expect(res.status).toBe(401);
  });

  it('hides diagnostics when ENABLE_DIAGNOSTICS=false', async () => {
    process.env.ENABLE_DIAGNOSTICS = 'false';
    try {
      expect((await request(app).get('/bff/health')).status).toBe(404);
      expect((await request(app).get('/metrics')).status).toBe(404);
    } finally {
      process.env.ENABLE_DIAGNOSTICS = 'true';
    }
  });
});
