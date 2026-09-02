'use strict';

// Helpers para limpiar y sembrar DB en tests
// Uso: const { cleanTable } = require('@erp/test-helpers');

async function cleanTable(pool, table) {
  // TRUNCATE con CASCADE para respetar FKs
  await pool.query(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
}

async function seedProducto(pool, data) {
  const { nombre, precio, stock } = data;
  const { rows } = await pool.query(
    'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING *',
    [nombre, precio, stock ?? 0]
  );
  return rows[0];
}

module.exports = { cleanTable, seedProducto };
