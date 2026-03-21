'use strict';

const request = require('supertest');
const app = require('../index');
const pool = require('../db');

afterAll(async () => {
  await pool.end();
});

describe('GET /', () => {
  it('returns service info without DB', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('svc-stock');
    expect(res.body.status).toBe('running');
  });
});

describe('GET /health', () => {
  it('returns 200 with db: connected when DB is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
  });
});

describe('POST /stock', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/stock').send({ producto_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when tipo is invalid', async () => {
    const res = await request(app)
      .post('/stock')
      .send({ producto_id: 1, cantidad: 5, tipo: 'invalido' });
    expect(res.status).toBe(400);
  });
});

describe('GET /stock', () => {
  it('returns an array', async () => {
    const res = await request(app).get('/stock');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });
});
