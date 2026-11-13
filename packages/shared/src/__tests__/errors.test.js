'use strict';

const express = require('express');
const request = require('supertest');

const { errorHandler, normalizeError } = require('../errors');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/pg/:code', (req, _res, next) => {
    next(Object.assign(new Error('database said no'), { code: req.params.code }));
  });
  app.get('/stock-conflict', (_req, _res, next) => {
    next(new Error('stock insuficiente para producto 1: stock=0 cantidad=1'));
  });
  app.post('/echo', (req, res) => res.json(req.body));
  app.use(errorHandler);
  return app;
}

describe('centralised error mapping', () => {
  const app = buildApp();

  it.each([
    ['23505', 409, 'CONFLICT'],
    ['23503', 409, 'CONFLICT'],
    ['22P02', 400, 'VALIDATION_ERROR'],
    ['22003', 400, 'VALIDATION_ERROR'],
  ])('maps PostgreSQL %s to %i %s', async (pgCode, status, code) => {
    const res = await request(app).get(`/pg/${pgCode}`);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.details.pgCode).toBe(pgCode);
    expect(res.body.error.message).not.toBe('internal error');
  });

  it('maps malformed JSON to 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('malformed JSON body');
  });

  it('maps the stock trigger exception to 409 STOCK_CONFLICT', async () => {
    const res = await request(app).get('/stock-conflict');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_CONFLICT');
  });

  it('leaves unknown errors as 500 internal error', () => {
    const err = normalizeError(new Error('unexpected'));
    expect(err.statusCode).toBeUndefined();
  });
});
