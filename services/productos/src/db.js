const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In production (ECS), enable SSL with full certificate verification.
  // node:20-alpine includes the Amazon Root CA in its system trust store,
  // so RDS certificates are verified without bundling extra CA files.
  ssl: process.env.NODE_ENV === 'production' ? true : false,
  max: 3,              // 3 services × 3 = 9 connections — leaves margin within RDS free-tier limit (~15)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
