'use strict';

const express = require('express');
const request = require('supertest');

const { auditLog, deriveResource, insertAuditRow } = require('../audit');
const { errorHandler } = require('../errors');

function recordingPool() {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1 }] };
    }),
  };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function buildApp(pool) {
  const app = express();
  app.use(express.json());
  app.use(auditLog({ pool, logger: { warn: jest.fn() } }));
  app.post('/productos/:id', (req, res) => {
    req.auth = { sub: 'u-1', role: 'operator', tenantId: 't-1' };
    req.id = 'req-123';
    res.status(201).json({ ok: true });
  });
  app.get('/productos', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('audit log', () => {
  it('derives the resource and id from legacy and versioned paths', () => {
    expect(deriveResource('/api/v1/productos/42')).toEqual({
      resource: 'productos',
      resourceId: '42',
    });
    expect(deriveResource('/ordenes')).toEqual({ resource: 'ordenes', resourceId: null });
    expect(deriveResource('/api/stock/7')).toEqual({ resource: 'stock', resourceId: '7' });
  });

  it('records an authenticated mutation with actor, action, status and request id', async () => {
    const pool = recordingPool();
    const res = await request(buildApp(pool)).post('/productos/42').send({});
    expect(res.status).toBe(201);
    await tick();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const params = pool.calls[0].params;
    expect(params).toEqual([
      'u-1',
      'operator',
      't-1',
      'post:productos',
      'productos',
      '42',
      201,
      'req-123',
      JSON.stringify({ method: 'POST', path: '/productos/42' }),
    ]);
  });

  it('does not break the response when the audit insert fails', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('audit down')) };
    const app = express();
    app.use(express.json());
    const warn = jest.fn();
    app.use(auditLog({ pool, logger: { warn } }));
    app.post('/productos', (req, res) => res.status(201).json({ ok: true }));

    const res = await request(app).post('/productos').send({});
    expect(res.status).toBe(201);
    await tick();
    expect(warn).toHaveBeenCalledWith(
      'audit_write_failed',
      expect.objectContaining({ error: 'audit down' })
    );
  });

  it('does not audit reads', async () => {
    const pool = recordingPool();
    const res = await request(buildApp(pool)).get('/productos');
    expect(res.status).toBe(200);
    await tick();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('writes a row even without req.auth (auth disabled in dev)', async () => {
    const pool = recordingPool();
    await insertAuditRow(
      pool,
      { method: 'POST', path: '/productos', id: 'r-1' },
      { statusCode: 201 }
    );
    expect(pool.calls[0].params.slice(0, 3)).toEqual([null, null, null]);
  });
});
