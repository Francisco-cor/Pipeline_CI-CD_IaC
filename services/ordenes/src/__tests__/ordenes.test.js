'use strict';

const { productoFactory, ordenFactory } = require('@erp/test-helpers');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

let productoId;
const PRECIO = 10;

beforeAll(async () => {
  // Ensure at least one producto exists for FK
  const p = productoFactory({ stock: 1000, precio: PRECIO });
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
      const outbox = await pool.query(
        'SELECT event_type, aggregate_id, published_at FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2',
        ['orden', res.body.data.id]
      );
      expect(outbox.rows).toEqual([
        expect.objectContaining({
          event_type: 'orden.creada',
          aggregate_id: String(res.body.data.id),
        }),
      ]);
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

  describe('POST /ordenes — server-side total and stock reservation', () => {
    async function createProducto(stock, precio = PRECIO) {
      const { rows } = await pool.query(
        'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
        [`order-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, precio, stock]
      );
      return rows[0].id;
    }

    async function stockOf(id) {
      const { rows } = await pool.query('SELECT stock FROM productos WHERE id = $1', [id]);
      return rows[0].stock;
    }

    it('ignores a manipulated client total and stores the server total', async () => {
      const id = await createProducto(20);
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: id, cantidad: 3, total: 0.01 });

      expect(res.status).toBe(201);
      expect(Number(res.body.data.total)).toBe(30);
      expect(res.body.data.estado).toBe('procesada');
      const { rows } = await pool.query('SELECT total FROM ordenes WHERE id = $1', [
        res.body.data.id,
      ]);
      expect(Number(rows[0].total)).toBe(30);
    });

    it('rejects overselling with 409 and leaves stock/order untouched', async () => {
      const id = await createProducto(1);
      const before = await stockOf(id);
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: id, cantidad: 2, total: 20 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STOCK_CONFLICT');
      expect(await stockOf(id)).toBe(before);

      const orders = await pool.query(
        'SELECT COUNT(*)::int AS n FROM ordenes WHERE producto_id = $1',
        [id]
      );
      expect(orders.rows[0].n).toBe(0);
      const movements = await pool.query(
        'SELECT COUNT(*)::int AS n FROM movimientos_stock WHERE producto_id = $1',
        [id]
      );
      expect(movements.rows[0].n).toBe(0);
    });

    it('reserves stock exactly once and commits the outbox events', async () => {
      const id = await createProducto(10);
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: id, cantidad: 3, total: 999 });

      expect(res.status).toBe(201);
      expect(await stockOf(id)).toBe(7);

      const movements = await pool.query(
        'SELECT cantidad, tipo FROM movimientos_stock WHERE producto_id = $1',
        [id]
      );
      expect(movements.rows).toEqual([{ cantidad: 3, tipo: 'salida' }]);

      const movementEvent = await pool.query(
        "SELECT COUNT(*)::int AS n FROM outbox_events WHERE event_type = 'stock.actualizado'"
      );
      expect(movementEvent.rows[0].n).toBeGreaterThan(0);
    });

    it('rejects a total that overflows NUMERIC(10,2)', async () => {
      const id = await createProducto(5, 99999999.99);
      const res = await request(app)
        .post('/ordenes')
        .send({ producto_id: id, cantidad: 2, total: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /ordenes — Idempotency-Key', () => {
    async function createProducto(stock) {
      const { rows } = await pool.query(
        'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id',
        [`idem-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, PRECIO, stock]
      );
      return rows[0].id;
    }

    it('replays the original response for a sequential duplicate', async () => {
      const id = await createProducto(10);
      const key = `orden-seq-${Date.now()}`;
      const body = { producto_id: id, cantidad: 2, total: 20 };

      const first = await request(app).post('/ordenes').set('Idempotency-Key', key).send(body);
      const second = await request(app).post('/ordenes').set('Idempotency-Key', key).send(body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.headers['idempotent-replayed']).toBe('true');

      const orders = await pool.query(
        'SELECT COUNT(*)::int AS n FROM ordenes WHERE producto_id = $1',
        [id]
      );
      expect(orders.rows[0].n).toBe(1);
      const movements = await pool.query(
        'SELECT COUNT(*)::int AS n FROM movimientos_stock WHERE producto_id = $1',
        [id]
      );
      expect(movements.rows[0].n).toBe(1);
    });

    it('returns the same response for concurrent duplicates', async () => {
      const id = await createProducto(10);
      const key = `orden-conc-${Date.now()}`;
      const body = { producto_id: id, cantidad: 1, total: 10 };

      const [a, b] = await Promise.all([
        request(app).post('/ordenes').set('Idempotency-Key', key).send(body),
        request(app).post('/ordenes').set('Idempotency-Key', key).send(body),
      ]);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.data.id).toBe(b.body.data.id);
      const orders = await pool.query(
        'SELECT COUNT(*)::int AS n FROM ordenes WHERE producto_id = $1',
        [id]
      );
      expect(orders.rows[0].n).toBe(1);
    });

    it('rejects the same key with a different body', async () => {
      const id = await createProducto(10);
      const key = `orden-mismatch-${Date.now()}`;

      const first = await request(app)
        .post('/ordenes')
        .set('Idempotency-Key', key)
        .send({ producto_id: id, cantidad: 1, total: 10 });
      const second = await request(app)
        .post('/ordenes')
        .set('Idempotency-Key', key)
        .send({ producto_id: id, cantidad: 2, total: 20 });

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
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
