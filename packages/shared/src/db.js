'use strict';

// SPDX-License-Identifier: MIT
// Shared DB pool — unifica los 3 db.js duplicados.
// Fase 2: extrae lógica SSL + pool sizing.

const { Pool } = require('pg');

/**
 * Crea un pg Pool con SSL auto-detección para RDS.
 * @param {object} [opts]
 * @param {string} [opts.connectionString] - default process.env.DATABASE_URL
 * @param {number} [opts.max] - default process.env.DB_POOL_MAX || 3
 */
function createPool(opts = {}) {
  const connectionString = opts.connectionString || process.env.DATABASE_URL;
  const max = opts.max || Number(process.env.DB_POOL_MAX) || 3;

  const pool = new Pool({
    connectionString,
    ssl:
      connectionString && connectionString.includes('amazonaws.com')
        ? { rejectUnauthorized: false }
        : false,
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
