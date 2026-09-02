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

describe('Contract — OpenAPI (ordenes)', () => {
  let spec;
  beforeAll(() => {
    const file = path.join(__dirname, '../../../../docs/openapi.yaml');
    spec = yaml.load(fs.readFileSync(file, 'utf8'));
  });

  it('has /api/v1/ordenes', async () => {
    expect(spec.paths['/api/v1/ordenes']).toBeDefined();
  });

  it('GET /ordenes paginated', async () => {
    const res = await request(app).get('/ordenes?limit=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
  });

  it('POST 404 FK matches Error', async () => {
    const res = await request(app).post('/ordenes').send({ producto_id: 999999, cantidad: 1, total: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
