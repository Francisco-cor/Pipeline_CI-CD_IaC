'use strict';

const {
  AppError,
  cache,
  parsePagination,
  publishStockActualizado,
  setPaginationHeaders,
  sortToOrderBy,
  stockSchema,
  validate,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// GET /stock — paginated
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset, sort } = parsePagination(req);
    const orderBy = sortToOrderBy(sort);

    const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM movimientos_stock');
    const total = totalResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT * FROM movimientos_stock ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    setPaginationHeaders(res, req, page, limit, total);

    res.json({ data: rows, count: rows.length, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// POST /stock — zod + transactional outbox (Fase 10.2) + outbox trigger sync productos.stock
router.post('/', validate(stockSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { producto_id, cantidad, tipo } = req.body;

    await client.query('BEGIN');
    // Bloquea producto y verifica existe; trigger 005 también valida stock insuficiente
    const prod = await client.query('SELECT id, stock FROM productos WHERE id=$1 FOR UPDATE', [
      producto_id,
    ]);
    if (prod.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'NOT_FOUND', `producto ${producto_id} not found`);
    }

    // Inserta movimiento — trigger check_and_update_stock ajusta productos.stock automáticamente
    const { rows } = await client.query(
      'INSERT INTO movimientos_stock (producto_id, cantidad, tipo) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, tipo]
    );

    await client.query('COMMIT');

    const movimiento = rows[0];

    // Invalida cache productos (stock cambió) — best effort
    cache.del('productos:list:*').catch(() => {});
    cache.del(`productos:id:${producto_id}`).catch(() => {});

    // Publica evento stock.actualizado (10.6) — best effort no bloquea
    publishStockActualizado(movimiento).catch(() => {});

    res.status(201).json({ data: movimiento });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      // ignore
    }
    // Mapea trigger exception stock insuficiente → 409
    if (err.message && err.message.includes('stock insuficiente')) {
      return next(new AppError(409, 'STOCK_CONFLICT', err.message));
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
