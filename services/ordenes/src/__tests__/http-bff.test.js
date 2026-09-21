'use strict';

// This suite uses a mocked downstream fetch so CI only needs PostgreSQL.
process.env.PRODUCTOS_URL = 'http://productos:3001';

const { productoFactory } = require('@erp/test-helpers');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

let productoId;
let ordenId;

beforeAll(async () => {
  const producto = productoFactory({ nombre: `HTTP-${Date.now()}-${Math.random()}` });
  const productoResult = await pool.query(
    'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
    [producto.nombre, producto.precio, producto.stock]
  );
  productoId = productoResult.rows[0].id;
  const ordenResult = await pool.query(
    'INSERT INTO ordenes (producto_id, cantidad, total) VALUES ($1, $2, $3) RETURNING id',
    [productoId, 1, 10]
  );
  ordenId = ordenResult.rows[0].id;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.PRODUCTOS_URL;
  await pool.end();
});

describe('HTTP product integration and BFF fallback', () => {
  it('verifies an existing product over HTTP before creating an order', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ data: { id: productoId, nombre: 'remote-product' } }),
    });

    const res = await request(app)
      .post('/ordenes')
      .set('X-Request-Id', 'http-test')
      .send({ producto_id: productoId, cantidad: 1, total: 12 });

    expect(res.status).toBe(201);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://productos:3001/productos/${productoId}`,
      expect.objectContaining({
        headers: { Accept: 'application/json', 'X-Request-Id': 'http-test' },
      })
    );
  });

  it('maps an HTTP 404 product response to an order 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false });
    const res = await request(app)
      .post('/ordenes')
      .send({ producto_id: 999999999, cantidad: 1, total: 12 });
    expect(res.status).toBe(404);
  });

  it('returns the product from the HTTP BFF aggregation', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ data: { id: productoId, nombre: 'remote-product' } }),
    });
    const res = await request(app).get(`/ordenes/${ordenId}?include=producto`);
    expect(res.status).toBe(200);
    expect(res.body.producto.id).toBe(productoId);
    expect(res.body._bff).toBe('orden+producto aggregated');
  });

  it('returns a warning when BFF product lookup returns 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false });
    const res = await request(app).get(`/ordenes/${ordenId}?include=producto`);
    expect(res.status).toBe(200);
    expect(res.body.producto).toBeNull();
    expect(res.body.warning).toContain('not found');
  });

  it('falls back to DB for HTTP errors and degrades BFF on a failed lookup', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const created = await request(app)
      .post('/ordenes')
      .send({ producto_id: productoId, cantidad: 1, total: 13 });
    expect(created.status).toBe(201);

    const degraded = await request(app).get(`/ordenes/${ordenId}?include=producto`);
    expect(degraded.status).toBe(200);
    expect(degraded.body._bff).toBe('degraded');
    expect(degraded.body.warning).toContain('fetch failed');
  });
});
