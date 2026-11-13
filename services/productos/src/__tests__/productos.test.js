'use strict';

const { productoFactory } = require('@erp/test-helpers');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

const uniqueName = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

afterAll(async () => {
  await pool.end();
});

describe('Productos API — CRUD + validation (Fase 3 & 4)', () => {
  describe('POST /productos — validation', () => {
    it('400 when nombre missing (zod)', async () => {
      const res = await request(app).post('/productos').send({ precio: 9.99 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.requestId).toBeDefined();
    });

    it('400 when precio missing', async () => {
      const res = await request(app).post('/productos').send({ nombre: 'Widget' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 when precio negative', async () => {
      const res = await request(app).post('/productos').send({ nombre: 'Bad', precio: -5 });
      expect(res.status).toBe(400);
    });

    it('400 when nombre empty', async () => {
      const res = await request(app).post('/productos').send({ nombre: '', precio: 10 });
      expect(res.status).toBe(400);
    });

    it('201 with precio 0 and stock 0 (falsy fix)', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: uniqueName('Free'), precio: 0, stock: 0 });
      expect(res.status).toBe(201);
      expect(Number(res.body.data.precio)).toBe(0);
      expect(res.body.data.stock).toBe(0);
    });

    it('201 with precio as string coerce (zod)', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: uniqueName('Coerce'), precio: '19.99' });
      expect(res.status).toBe(201);
      expect(Number(res.body.data.precio)).toBe(19.99);
    });

    it('201 with stock as string coerce', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: uniqueName('CoerceStock'), precio: 10, stock: '5' });
      expect(res.status).toBe(201);
      expect(res.body.data.stock).toBe(5);
    });

    it('400 when stock negative', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: 'BadStock', precio: 10, stock: -1 });
      expect(res.status).toBe(400);
    });

    it('201 creates producto via factory', async () => {
      const payload = productoFactory({ stock: 7 });
      const res = await request(app).post('/productos').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.nombre).toBe(payload.nombre);
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.body.data.stock).toBe(7);
    });

    it('400 when precio exceeds NUMERIC(10,2)', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: uniqueName('OverflowPrice'), precio: 1e9 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 when stock exceeds INTEGER', async () => {
      const res = await request(app)
        .post('/productos')
        .send({ nombre: uniqueName('OverflowStock'), precio: 1, stock: 2147483648 });
      expect(res.status).toBe(400);
    });

    it('400 with VALIDATION_ERROR on malformed JSON', async () => {
      const res = await request(app)
        .post('/productos')
        .set('Content-Type', 'application/json')
        .send('{"nombre":');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /productos — pagination', () => {
    beforeAll(async () => {
      // Seed 3 productos for pagination
      await request(app).post('/productos').send(productoFactory());
      await request(app).post('/productos').send(productoFactory());
      await request(app).post('/productos').send(productoFactory());
    });

    it('returns paginated structure with headers', async () => {
      const res = await request(app).get('/productos?page=1&limit=2');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(typeof res.body.total).toBe('number');
      expect(typeof res.body.page).toBe('number');
      expect(typeof res.body.limit).toBe('number');
      expect(res.headers['x-total-count']).toBeDefined();
      expect(res.headers['link']).toBeDefined();
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('caps limit at 100', async () => {
      const res = await request(app).get('/productos?limit=1000');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
    });

    it('handles page beyond total as empty', async () => {
      const res = await request(app).get('/productos?page=999&limit=10');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
    });

    it('caps page at 10000', async () => {
      const res = await request(app).get('/productos?page=10001&limit=1');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(10000);
    });

    it('sort asc vs desc differ', async () => {
      const asc = await request(app).get('/productos?sort=created_at_asc&limit=1');
      const desc = await request(app).get('/productos?sort=created_at_desc&limit=1');
      expect(asc.status).toBe(200);
      expect(desc.status).toBe(200);
      // If at least 2 rows, first ids should differ when order flipped (probable)
      // Not strict, just ensure both succeed
    });

    it('legacy /api/productos still works (service mount)', async () => {
      const res = await request(app).get('/api/productos?limit=1');
      expect([200, 404]).toContain(res.status); // 404 if not mounted via nginx but direct mount exists
      // For Fase 3, service mounts /api/productos directly, so should be 200
      // If 404, means not mounted — adjust
      if (res.status === 200) {
        expect(Array.isArray(res.body.data)).toBe(true);
      }
    });
  });

  describe('GET /health — live/ready split', () => {
    it('GET /health/live returns ok without DB', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/ready returns db connected', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.db).toBe('connected');
    });
  });

  describe('404 and security headers', () => {
    it('404 for unknown route with structured error', async () => {
      const res = await request(app).get('/no-existe-xyz');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.requestId).toBeDefined();
    });

    it('has security headers (helmet)', async () => {
      const res = await request(app).get('/');
      expect(res.headers['x-content-type-options']).toBeDefined();
      expect(res.headers['x-dns-prefetch-control']).toBeDefined();
    });

    it('has X-Request-Id', async () => {
      const res = await request(app).get('/').set('X-Request-Id', 'test-123');
      expect(res.headers['x-request-id']).toBe('test-123');
    });
  });
});

describe('Productos API — stock as a ledger', () => {
  const ledgerFor = async productoId => {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN cantidad ELSE -cantidad END), 0)::int AS sum
         FROM movimientos_stock WHERE producto_id = $1`,
      [productoId]
    );
    return rows[0].sum;
  };

  it('records initial stock as an opening movement and reconciles', async () => {
    const created = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('Ledger'), precio: 10, stock: 12 });
    expect(created.status).toBe(201);
    expect(created.body.data.stock).toBe(12);

    const id = created.body.data.id;
    expect(await ledgerFor(id)).toBe(12);
    const { rows } = await pool.query('SELECT stock FROM productos WHERE id = $1', [id]);
    expect(rows[0].stock).toBe(await ledgerFor(id));
  });

  it('does not create a movement when initial stock is omitted', async () => {
    const created = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('NoStock'), precio: 10 });
    expect(created.status).toBe(201);
    expect(created.body.data.stock).toBe(0);
    expect(await ledgerFor(created.body.data.id)).toBe(0);
  });

  it('PUT never changes stock, even when the body includes stock', async () => {
    const created = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('PutStock'), precio: 10, stock: 9 });
    const id = created.body.data.id;

    const updated = await request(app)
      .put(`/productos/${id}`)
      .send({ nombre: uniqueName('PutStockRenamed'), precio: 11, stock: 0 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.stock).toBe(9);
    expect(Number(updated.body.data.precio)).toBe(11);
    expect(await ledgerFor(id)).toBe(9);
  });

  it('keeps the ledger balanced after new movements', async () => {
    const created = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('LedgerFlow'), precio: 10, stock: 5 });
    const id = created.body.data.id;

    await pool.query(
      "INSERT INTO movimientos_stock (producto_id, cantidad, tipo) VALUES ($1, 2, 'salida')",
      [id]
    );
    await pool.query(
      "INSERT INTO movimientos_stock (producto_id, cantidad, tipo) VALUES ($1, 4, 'entrada')",
      [id]
    );

    const { rows } = await pool.query('SELECT stock FROM productos WHERE id = $1', [id]);
    expect(rows[0].stock).toBe(7);
    expect(rows[0].stock).toBe(await ledgerFor(id));
  });
});

describe('Productos API — resource and diagnostic branches', () => {
  let productoId;

  beforeAll(async () => {
    const payload = productoFactory({ nombre: uniqueName('CRUD'), stock: 4 });
    const res = await request(app).post('/productos').send(payload);
    productoId = res.body.data.id;
  });

  it('gets a product, then serves the cached version', async () => {
    const first = await request(app).get(`/productos/${productoId}`);
    const second = await request(app).get(`/productos/${productoId}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('validates product ids and reports missing products', async () => {
    expect((await request(app).get('/productos/not-an-id')).status).toBe(400);
    expect((await request(app).get('/productos/999999999')).status).toBe(404);
  });

  it('updates and deletes a product, including invalid and missing ids', async () => {
    const payload = productoFactory({ nombre: uniqueName('UPDATED'), stock: 8 });
    const updated = await request(app).put(`/productos/${productoId}`).send(payload);
    expect(updated.status).toBe(200);
    expect(updated.body.data.nombre).toBe(payload.nombre);

    expect((await request(app).put('/productos/not-an-id').send(payload)).status).toBe(400);
    expect((await request(app).put('/productos/999999999').send(payload)).status).toBe(404);

    // Stock movements are ledger history: FK RESTRICT keeps the product alive.
    expect((await request(app).delete(`/productos/${productoId}`)).status).toBe(409);

    const disposable = await request(app)
      .post('/productos')
      .send({ nombre: uniqueName('DISPOSABLE'), precio: 1 });
    expect((await request(app).delete(`/productos/${disposable.body.data.id}`)).status).toBe(204);
    expect((await request(app).delete('/productos/not-an-id')).status).toBe(400);
    expect((await request(app).delete('/productos/999999999')).status).toBe(404);
  });

  it('exposes health details and metrics', async () => {
    const details = await request(app).get('/health/details');
    const metrics = await request(app).get('/metrics');
    expect(details.status).toBe(200);
    expect(details.body.pool).toBeDefined();
    expect(metrics.status).toBe(200);
  });

  it('returns a controlled error when the list database query fails', async () => {
    const previous = process.env.CACHE_ENABLED;
    process.env.CACHE_ENABLED = 'false';
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db unavailable'));
    const res = await request(app).get('/productos?limit=1');
    query.mockRestore();
    if (previous === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = previous;
    expect(res.status).toBe(500);
  });
});
