'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const pool = require('../db');
const app = require('../index');

const SECRET = 'integration-jwt-secret';

function token(role, overrides = {}, options = {}) {
  return jwt.sign({ sub: 'it-user', role, tenant_id: 'it-tenant', ...overrides }, SECRET, {
    expiresIn: '1h',
    ...options,
  });
}

const bearer = value => ({ Authorization: `Bearer ${value}` });
const uniqueName = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function auditRowFor(requestId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query('SELECT * FROM audit_log WHERE request_id = $1', [requestId]);
    if (rows.length > 0) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

afterAll(async () => {
  await pool.end();
});

describe('Productos — authentication and RBAC', () => {
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_ENABLED = 'true';
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_PUBLIC_KEY;
  });

  afterAll(() => {
    process.env = previous;
  });

  it('keeps health, metadata and metrics public', async () => {
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/metrics')).status).toBe(200);
  });

  it('hides diagnostics when ENABLE_DIAGNOSTICS=false', async () => {
    process.env.ENABLE_DIAGNOSTICS = 'false';
    try {
      expect((await request(app).get('/health/details')).status).toBe(404);
      expect((await request(app).get('/metrics')).status).toBe(404);
      expect((await request(app).get('/health/ready')).status).toBe(200);
    } finally {
      process.env.ENABLE_DIAGNOSTICS = 'true';
    }
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/productos');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an expired token', async () => {
    const expired = jwt.sign({ sub: 'u', role: 'reader' }, SECRET, { expiresIn: -5 });
    const res = await request(app).get('/productos').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('allows reads for every role', async () => {
    for (const role of ['reader', 'operator', 'admin']) {
      const res = await request(app)
        .get('/api/v1/productos?limit=1')
        .set(bearer(token(role)));
      expect(res.status).toBe(200);
    }
  });

  it('returns 403 when a reader tries to create', async () => {
    const res = await request(app)
      .post('/productos')
      .set(bearer(token('reader')))
      .send({ nombre: uniqueName('Denied'), precio: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows operator to create and admin to delete', async () => {
    const created = await request(app)
      .post('/productos')
      .set(bearer(token('operator')))
      .send({ nombre: uniqueName('RBAC'), precio: 2 });
    expect(created.status).toBe(201);

    const denied = await request(app)
      .delete(`/productos/${created.body.data.id}`)
      .set(bearer(token('operator')));
    expect(denied.status).toBe(403);

    const deleted = await request(app)
      .delete(`/productos/${created.body.data.id}`)
      .set(bearer(token('admin')));
    expect(deleted.status).toBe(204);
  });

  it('records an audit row for an authenticated mutation', async () => {
    const requestId = `audit-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(app)
      .post('/api/v1/productos')
      .set(bearer(token('operator', { sub: 'auditor' })))
      .set('X-Request-Id', requestId)
      .send({ nombre: uniqueName('Audited'), precio: 3 });
    expect(res.status).toBe(201);

    const row = await auditRowFor(requestId);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      actor_sub: 'auditor',
      actor_role: 'operator',
      tenant_id: 'it-tenant',
      action: 'post:productos',
      resource: 'productos',
      status: 201,
    });
    expect(row.metadata).toMatchObject({ method: 'POST' });
  });
});
