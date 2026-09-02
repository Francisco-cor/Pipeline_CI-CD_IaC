'use strict';

const {
  validate,
  stockSchema,
  parsePagination,
  setPaginationHeaders,
  sortToOrderBy,
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

// POST /stock — zod
router.post('/', validate(stockSchema), async (req, res, next) => {
  try {
    const { producto_id, cantidad, tipo } = req.body;

    const { rows } = await pool.query(
      'INSERT INTO movimientos_stock (producto_id, cantidad, tipo) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, tipo]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
