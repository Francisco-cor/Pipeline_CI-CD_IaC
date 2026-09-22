'use strict';

const { stockFactory, productoFactory } = require('@erp/test-helpers');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

let productoId;

beforeAll(async () => {
  const p = productoFactory();
  const { rows } = await pool.query(
    'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
    [p.nombre, p.precio, p.stock]
  );
  productoId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('Stock API — CRUD + validation', () => {
  describe('POST /stock — validation', () => {
    it('400 when required fields missing', async () => {
      const res = await request(app).post('/stock').send({ producto_id: productoId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 when tipo invalid', async () => {
      const res = await request(app)
        .post('/stock')
        .send({ producto_id: productoId, cantidad: 5, tipo: 'invalido' });
      expect(res.status).toBe(400);
    });

    it('201 entrada', async () => {
      const payload = stockFactory({ producto_id: productoId, tipo: 'entrada' });
      const res = await request(app).post('/stock').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.tipo).toBe('entrada');
      const outbox = await pool.query(
        'SELECT event_type, aggregate_id FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2',
        ['movimiento_stock', res.body.data.id]
      );
      expect(outbox.rows).toEqual([
        expect.objectContaining({
          event_type: 'stock.actualizado',
          aggregate_id: String(res.body.data.id),
        }),
      ]);
    });

    it('201 salida', async () => {
      const payload = stockFactory({ producto_id: productoId, tipo: 'salida' });
      const res = await request(app).post('/stock').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.tipo).toBe('salida');
    });

    it('400 when cantidad 0', async () => {
      const res = await request(app)
        .post('/stock')
        .send({ producto_id: productoId, cantidad: 0, tipo: 'entrada' });
      expect(res.status).toBe(400);
    });

    it('coerces string cantidad', async () => {
      const res = await request(app)
        .post('/stock')
        .send({ producto_id: String(productoId), cantidad: '3', tipo: 'entrada' });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /stock — pagination', () => {
    it('returns paginated with headers', async () => {
      const res = await request(app).get('/stock?limit=2');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.headers['x-total-count']).toBeDefined();
      expect(res.headers['link']).toBeDefined();
    });

    it('caps limit', async () => {
      const res = await request(app).get('/stock?limit=999');
      expect(res.body.limit).toBe(100);
    });
  });

  describe('Health', () => {
    it('live', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
    });
    it('ready', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
    });
  });

  describe('404', () => {
    it('unknown', async () => {
      const res = await request(app).get('/no-existe');
      expect(res.status).toBe(404);
    });
  });
});

describe('Stock API — conflict and diagnostics', () => {
  let lowStockProductId;

  beforeAll(async () => {
    const p = productoFactory({ nombre: `LOW-STOCK-${Date.now()}`, stock: 1 });
    const { rows } = await pool.query(
      'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
      [p.nombre, p.precio, p.stock]
    );
    lowStockProductId = rows[0].id;
  });

  it('returns 404 for a missing product', async () => {
    const res = await request(app)
      .post('/stock')
      .send({ producto_id: 999999999, cantidad: 1, tipo: 'entrada' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when an exit exceeds available stock', async () => {
    const res = await request(app)
      .post('/stock')
      .send({ producto_id: lowStockProductId, cantidad: 2, tipo: 'salida' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_CONFLICT');
  });

  it('exposes health details and metrics', async () => {
    const details = await request(app).get('/health/details');
    const metrics = await request(app).get('/metrics');
    expect(details.status).toBe(200);
    expect(details.body.pool).toBeDefined();
    expect(metrics.status).toBe(200);
  });
});
