'use strict';

const request = require('supertest');

const app = require('../index');

describe('Gateway API', () => {
  it('returns service metadata without touching the database', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: 'svc-gateway',
      status: 'running',
    });
  });

  it('exposes a liveness endpoint that does not require the database', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'svc-gateway' });
  });

  it('does not reflect oversized request IDs into response headers', async () => {
    const response = await request(app).get('/').set('X-Request-Id', 'x'.repeat(129));

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).not.toHaveLength(129);
  });

  it('rejects invalid BFF identifiers before making downstream calls', async () => {
    const response = await request(app).get('/bff/ordenes/not-an-id');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error).toEqual(
      expect.objectContaining({ code: 'NOT_FOUND', requestId: expect.any(String) })
    );
  });
});
