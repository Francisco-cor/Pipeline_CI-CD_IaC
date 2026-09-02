'use strict';

// SPDX-License-Identifier: MIT
// Shared DB pool — unifica los 3 db.js duplicados.
// Fase 2: extrae lógica SSL + pool sizing.
// Fase 8.2: prod SSL con CA bundle + rejectUnauthorized:true (checkov + RDS TLS)

const fs = require('fs');
const path = require('path');

const { Pool } = require('pg');

/**
 * Crea un pg Pool con SSL auto-detección para RDS.
 * @param {object} [opts]
 * @param {string} [opts.connectionString] - default process.env.DATABASE_URL
 * @param {number} [opts.max] - default process.env.DB_POOL_MAX || 3
 */
function getSslConfig(connectionString) {
  const isRds = Boolean(connectionString && connectionString.includes('amazonaws.com'));
  if (!isRds) return false;
  // Fase 8.2 — prod usa CA bundle + rejectUnauthorized:true, dev mantiene false para DX local
  const isProd = process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'prod';
  if (!isProd) return { rejectUnauthorized: false };
  // Prod: intenta cargar CA bundle (montado en /app/certs/rds-ca-bundle.pem o env RDS_CA_BUNDLE / RDS_CA_PATH)
  try {
    const caInline = process.env.RDS_CA_BUNDLE;
    if (caInline) return { rejectUnauthorized: true, ca: caInline };
    const caPath =
      process.env.RDS_CA_PATH ||
      path.join(__dirname, '..', '..', '..', 'certs', 'rds-ca-bundle.pem');
    // También prueba /app/certs y ./certs (Docker prod vs local)
    const candidates = [
      caPath,
      '/app/certs/rds-ca-bundle.pem',
      path.join(process.cwd(), 'certs/rds-ca-bundle.pem'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const ca = fs.readFileSync(p, 'utf8');
        if (ca && ca.includes('BEGIN CERTIFICATE')) return { rejectUnauthorized: true, ca };
      }
    }
    // Fallback: sin CA file, forza true (requiere cert válido del servidor; RDS lo provee)
    return { rejectUnauthorized: true };
  } catch (_e) {
    return { rejectUnauthorized: true };
  }
}

function createPool(opts = {}) {
  const connectionString = opts.connectionString || process.env.DATABASE_URL;
  const max = opts.max || Number(process.env.DB_POOL_MAX) || 3;

  const pool = new Pool({
    connectionString,
    ssl: getSslConfig(connectionString),
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', err => {
    // shared logger evita require circular; usa console.error directo para idle errors.
    // El proceso debe terminar para que ECS lo reinicie.
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: process.env.SERVICE_NAME || 'db',
        message: 'Unexpected error on idle client',
        error: err.message,
      })
    );
    process.exit(-1);
  });

  return pool;
}

// Singleton default — mantiene comportamiento previo: `const pool = require('./db')`
const pool = createPool();

module.exports = pool;
module.exports.createPool = createPool;
module.exports.pool = pool;
