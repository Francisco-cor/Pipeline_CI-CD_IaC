'use strict';

const express = require('express');
const request = require('supertest');

const pool = require('../db');
const { errorHandler } = require('../errors');
const { idempotency } = require('../idempotency');

const scope = `test:idem:${Date.now()}`;
const app = express();
app.use(express.json());

let executions = 0;
app.post('/items', idempotency({ scope, pool, waitMs: 3000 }), async (req, res) => {
  executions += 1;
  const id = executions;
  if (req.body.slow) await new Promise(resolve => setTimeout(resolve, 150));
  res.status(201).json({ id, body: req.body });
});
app.use(errorHandler);

afterAll(async () => {
  await pool.query('DELETE FROM idempotency_keys WHERE scope = $1', [scope]);
  await pool.end();
});

describe('Idempotency-Key middleware', () => {
  it('replays the stored response for a sequential duplicate', async () => {
    const key = `seq-${Date.now()}`;
    const body = { value: 1 };

    const first = await request(app).post('/items').set('Idempotency-Key', key).send(body);
    const second = await request(app).post('/items').set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('serialises concurrent duplicates to one execution', async () => {
    const key = `conc-${Date.now()}`;
    const body = { value: 2, slow: true };
    const before = executions;

    const [a, b] = await Promise.all([
      request(app).post('/items').set('Idempotency-Key', key).send(body),
      request(app).post('/items').set('Idempotency-Key', key).send(body),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(executions).toBe(before + 1);
  });

  it('rejects the same key with a different body', async () => {
    const key = `mismatch-${Date.now()}`;
    await request(app).post('/items').set('Idempotency-Key', key).send({ value: 1 });
    const res = await request(app).post('/items').set('Idempotency-Key', key).send({ value: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects invalid keys', async () => {
    const res = await request(app).post('/items').set('Idempotency-Key', 'bad key').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does nothing when the header is absent', async () => {
    const before = executions;
    const res = await request(app).post('/items').send({ value: 3 });
    expect(res.status).toBe(201);
    expect(executions).toBe(before + 1);
  });
});
