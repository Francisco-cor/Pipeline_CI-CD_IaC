'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

const SECRET = 'stock-jwt-secret';
const sign = role =>
  jwt.sign({ sub: 'stock-user', role, tenant_id: 't-1' }, SECRET, { expiresIn: '1h' });

afterAll(async () => {
  await pool.end();
});

describe('Stock — RBAC', () => {
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
    const res = await request(app).get('/stock');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows reads for a reader token', async () => {
    const res = await request(app)
      .get('/api/v1/stock?limit=1')
      .set('Authorization', `Bearer ${sign('reader')}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 when a reader writes a movement', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', `Bearer ${sign('reader')}`)
      .send({ producto_id: 1, cantidad: 1, tipo: 'entrada' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
