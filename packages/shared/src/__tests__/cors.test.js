'use strict';

const cors = require('cors');
const express = require('express');
const request = require('supertest');

const { createCorsOptions } = require('../middleware');

function appWith(options) {
  const app = express();
  app.use(cors(options));
  app.get('/ping', (req, res) => res.json({ ok: true }));
  return app;
}

describe('CORS allowlist', () => {
  it('reflects an allowed origin from CORS_ORIGIN', async () => {
    const options = createCorsOptions({
      NODE_ENV: 'prod',
      CORS_ORIGIN: 'https://erp.example, https://admin.example',
    });
    const res = await request(appWith(options)).get('/ping').set('Origin', 'https://admin.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.example');
  });

  it('does not emit CORS headers for an origin outside the allowlist', async () => {
    const options = createCorsOptions({ NODE_ENV: 'prod', CORS_ORIGIN: 'https://erp.example' });
    const res = await request(appWith(options)).get('/ping').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('fails closed in production without an allowlist', async () => {
    const res = await request(appWith(createCorsOptions({ NODE_ENV: 'prod' })))
      .get('/ping')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps the wildcard for dev/test', async () => {
    const res = await request(appWith(createCorsOptions({ NODE_ENV: 'test' })))
      .get('/ping')
      .set('Origin', 'https://anything.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
