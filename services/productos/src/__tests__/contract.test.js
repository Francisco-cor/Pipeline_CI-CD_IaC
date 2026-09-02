'use strict';

const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

afterAll(async () => {
  await pool.end();
});

describe('Contract — OpenAPI (productos)', () => {
  let spec;

  beforeAll(() => {
    const file = path.join(__dirname, '../../../../docs/openapi.yaml');
    spec = yaml.load(fs.readFileSync(file, 'utf8'));
  });

  it('openapi.yaml is valid and has /api/v1/productos', async () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/api/v1/productos']).toBeDefined();
    expect(spec.paths['/api/v1/productos'].get).toBeDefined();
  });

  it('GET /productos matches paginated schema', async () => {
    const res = await request(app).get('/productos?limit=1');
    expect(res.status).toBe(200);
    // Contract from openapi: PaginatedProductos
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('limit');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('POST /productos 400 matches Error schema', async () => {
    const res = await request(app).post('/productos').send({ nombre: '', precio: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.requestId).toBeDefined();
  });

  it('GET /health matches HealthOk', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
  });
});
