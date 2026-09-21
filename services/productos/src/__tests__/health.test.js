'use strict';

const request = require('supertest');

const pool = require('../db');
const app = require('../index');

const uniqueName = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

afterAll(async () => {
  await pool.end();
});

describe('GET /', () => {
  it('returns service info without DB', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('svc-productos');
    expect(res.body.status).toBe('running');
  });
});

describe('GET /health', () => {
  it('returns 200 with db: connected when DB is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(typeof res.body.latency_ms).toBe('number');
  });

  it('returns 500 when the database is unavailable', async () => {
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db unavailable'));
    const res = await request(app).get('/health');
    query.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.db).toBe('disconnected');
  });
});

describe('GET /health/ready and /health/details', () => {
  it('returns 500 for readiness when the database is unavailable', async () => {
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db unavailable'));
    const res = await request(app).get('/health/ready');
    query.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.db).toBe('disconnected');
  });

  it('reports disconnected details without throwing', async () => {
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db unavailable'));
    const res = await request(app).get('/health/details');
    query.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.db).toBe('disconnected');
  });
});

describe('POST /productos', () => {
  it('returns 400 when nombre is missing', async () => {
    const res = await request(app).post('/productos').send({ precio: 9.99 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when precio is missing', async () => {
    const res = await request(app).post('/productos').send({ nombre: 'Widget' });
    expect(res.status).toBe(400);
  });

  it('creates a producto and returns 201', async () => {
    const res = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('CI-Test-Widget'), precio: 4.99 });
    expect(res.status).toBe(201);
    expect(res.body.data.nombre).toContain('CI-Test-Widget');
    expect(Number(res.body.data.precio)).toBe(4.99);
  });
});

describe('GET /productos', () => {
  it('returns an array', async () => {
    const res = await request(app).get('/productos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });
});
