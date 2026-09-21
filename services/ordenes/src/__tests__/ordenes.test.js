'use strict';

const { productoFactory, ordenFactory } = require('@erp/test-helpers');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

let productoId;

beforeAll(async () => {
  // Ensure at least one producto exists for FK
  const p = productoFactory();
  await request(app)
    .post('/ordenes')
    .send({ producto_id: 999999, cantidad: 1, total: 10 })
    .catch(() => {});
  // Create real producto via productos service DB directly if ordenes cannot create producto
  // Instead insert via productos pool (same DB)
  const { rows } = await pool.query(
    'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
    [p.nombre, p.precio, p.stock]
  );
  productoId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('Ordenes API — CRUD + validation', () => {
  describe('POST /ordenes — validation', () => {
    it('400 when required fields missing', async () => {
      const res = await request(app).post('/ordenes').send({ producto_id: productoId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 when cantidad is 0', async () => {
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: productoId, cantidad: 0, total: 10 });
      expect(res.status).toBe(400);
    });

    it('404 when producto_id FK not found', async () => {
      const payload = ordenFactory({ producto_id: 999999 });
      const res = await request(app).post('/ordenes').send(payload);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('201 with valid orden', async () => {
      const payload = ordenFactory({ producto_id: productoId });
      const res = await request(app).post('/ordenes').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.producto_id).toBe(productoId);
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('400 when total negative', async () => {
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: productoId, cantidad: 1, total: -5 });
      expect(res.status).toBe(400);
    });

    it('coerces string numbers', async () => {
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: String(productoId), cantidad: '2', total: '20.5' });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /ordenes — pagination', () => {
    it('returns paginated with headers', async () => {
      const res = await request(app).get('/ordenes?limit=2&page=1');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.headers['x-total-count']).toBeDefined();
      expect(res.headers['link']).toBeDefined();
      expect(res.body.total).toBeDefined();
    });

    it('caps limit at 100', async () => {
      const res = await request(app).get('/ordenes?limit=1000');
      expect(res.body.limit).toBe(100);
    });
  });

  describe('Health', () => {
    it('GET /health/live ok', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
    });
    it('GET /health/ready ok', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
    });
  });

  describe('404', () => {
    it('unknown route', async () => {
      const res = await request(app).get('/no-existe');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('Ordenes API — resource, BFF and diagnostics', () => {
  let ordenId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/ordenes')
      .send(ordenFactory({ producto_id: productoId, cantidad: 1, total: 11 }));
    ordenId = res.body.data.id;
  });

  it('gets an order with and without producto aggregation', async () => {
    const plain = await request(app).get(`/ordenes/${ordenId}`);
    const aggregated = await request(app).get(`/ordenes/${ordenId}?include=producto`);
    expect(plain.status).toBe(200);
    expect(plain.body.data.id).toBe(ordenId);
    expect(aggregated.status).toBe(200);
    expect(aggregated.body.producto.id).toBe(productoId);
    expect(aggregated.body._bff).toContain('aggregated');
  });

  it('validates order ids and reports missing orders', async () => {
    expect((await request(app).get('/ordenes/not-an-id')).status).toBe(400);
    expect((await request(app).get('/ordenes/999999999')).status).toBe(404);
  });

  it('exposes circuit stats outside production and hides them in production', async () => {
    const stats = await request(app).get('/ordenes/_circuit');
    expect(stats.status).toBe(200);
    expect(stats.body).toHaveProperty('state');

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const hidden = await request(app).get('/ordenes/_circuit');
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    expect(hidden.status).toBe(404);
  });

  it('exposes health details and metrics', async () => {
    const details = await request(app).get('/health/details');
    const metrics = await request(app).get('/metrics');
    expect(details.status).toBe(200);
    expect(details.body.pool).toBeDefined();
    expect(metrics.status).toBe(200);
  });
});
