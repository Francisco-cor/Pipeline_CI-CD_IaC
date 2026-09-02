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

describe('Contract — OpenAPI (stock)', () => {
  let spec;
  beforeAll(() => {
    const file = path.join(__dirname, '../../../../docs/openapi.yaml');
    spec = yaml.load(fs.readFileSync(file, 'utf8'));
  });

  it('has /api/v1/stock', async () => {
    expect(spec.paths['/api/v1/stock']).toBeDefined();
  });

  it('GET /stock paginated', async () => {
    const res = await request(app).get('/stock?limit=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('POST 400 tipo enum', async () => {
    const res = await request(app).post('/stock').send({ producto_id: 1, cantidad: 1, tipo: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
