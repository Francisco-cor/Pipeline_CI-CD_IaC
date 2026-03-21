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
      .send({ nombre: 'CI Test Widget', precio: 4.99 });
    expect(res.status).toBe(201);
    expect(res.body.data.nombre).toBe('CI Test Widget');
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
