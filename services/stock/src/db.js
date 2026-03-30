const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Detect if we are connecting to AWS RDS. If so, enable SSL (required by AWS).
  // rejectUnauthorized: false is used to skip local CA verification for dev convenience.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('amazonaws.com')
    ? { rejectUnauthorized: false }
    : false,
  max: 3,              // 3 services × 3 = 9 connections — leaves margin within RDS free-tier limit (~15)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
