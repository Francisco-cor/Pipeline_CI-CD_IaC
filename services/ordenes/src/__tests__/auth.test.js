'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

const SECRET = 'ordenes-jwt-secret';
const sign = (role, options = {}) =>
  jwt.sign({ sub: 'ordenes-user', role, tenant_id: 't-1' }, SECRET, {
    expiresIn: '1h',
    ...options,
  });

afterAll(async () => {
  await pool.end();
});

describe('Ordenes — RBAC', () => {
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_ENABLED = 'true';
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_PUBLIC_KEY;
  });

  afterAll(() => {
    process.env = previous;
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/ordenes');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired token', async () => {
    const expired = sign('reader', { expiresIn: -1 });
    const res = await request(app).get('/ordenes').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('allows reads for a reader token', async () => {
    const res = await request(app)
      .get('/api/v1/ordenes?limit=1')
      .set('Authorization', `Bearer ${sign('reader')}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 when a reader creates an order', async () => {
    const res = await request(app)
      .post('/ordenes')
      .set('Authorization', `Bearer ${sign('reader')}`)
      .send({ producto_id: 1, cantidad: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
