'use strict';

const {
  validate,
  ordenSchema,
  parsePagination,
  setPaginationHeaders,
  sortToOrderBy,
  AppError,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// GET /ordenes — paginated
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset, sort } = parsePagination(req);
    const orderBy = sortToOrderBy(sort);

    const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM ordenes');
    const total = totalResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT * FROM ordenes ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    setPaginationHeaders(res, req, page, limit, total);

    res.json({ data: rows, count: rows.length, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// POST /ordenes — zod + FK check
router.post('/', validate(ordenSchema), async (req, res, next) => {
  try {
    const { producto_id, cantidad, total } = req.body;

    const { rowCount } = await pool.query('SELECT 1 FROM productos WHERE id = $1', [producto_id]);
    if (rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', `producto ${producto_id} not found`);
    }

    const { rows } = await pool.query(
      'INSERT INTO ordenes (producto_id, cantidad, total) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, total]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
