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
    expect(res.body.service).toBe('svc-ordenes');
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

describe('POST /ordenes', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/ordenes').send({ producto_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when cantidad is missing', async () => {
    const res = await request(app)
      .post('/ordenes')
      .send({ producto_id: 1, total: 10 });
    expect(res.status).toBe(400);
  });
});

describe('GET /ordenes', () => {
  it('returns an array', async () => {
    const res = await request(app).get('/ordenes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });
});
