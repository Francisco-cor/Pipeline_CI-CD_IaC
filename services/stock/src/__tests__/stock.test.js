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
      const res = await request(app).post('/stock').send({ producto_id: productoId, cantidad: 5, tipo: 'invalido' });
      expect(res.status).toBe(400);
    });

    it('201 entrada', async () => {
      const payload = stockFactory({ producto_id: productoId, tipo: 'entrada' });
      const res = await request(app).post('/stock').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.tipo).toBe('entrada');
    });

    it('201 salida', async () => {
      const payload = stockFactory({ producto_id: productoId, tipo: 'salida' });
      const res = await request(app).post('/stock').send(payload);
      expect(res.status).toBe(201);
      expect(res.body.data.tipo).toBe('salida');
    });

    it('400 when cantidad 0', async () => {
      const res = await request(app).post('/stock').send({ producto_id: productoId, cantidad: 0, tipo: 'entrada' });
      expect(res.status).toBe(400);
    });

    it('coerces string cantidad', async () => {
      const res = await request(app).post('/stock').send({ producto_id: String(productoId), cantidad: '3', tipo: 'entrada' });
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
