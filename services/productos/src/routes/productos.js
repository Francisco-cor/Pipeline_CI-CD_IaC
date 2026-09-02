'use strict';

const {
  validate,
  productoSchema,
  parsePagination,
  setPaginationHeaders,
  sortToOrderBy,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// GET /productos — paginated (Fase 3.7), zod query validation
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset, sort } = parsePagination(req);
    const orderBy = sortToOrderBy(sort);

    // Total count for headers
    const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM productos');
    const total = totalResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT * FROM productos ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    setPaginationHeaders(res, req, page, limit, total);

    res.json({
      data: rows,
      count: rows.length, // compat
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// POST /productos — zod validation + fix falsy (Fase 3.3-3.4)
router.post('/', validate(productoSchema), async (req, res, next) => {
  try {
    const { nombre, precio, stock } = req.body;
    const stockVal = stock ?? 0; // fix: stock || 0 breaks stock=0

    const { rows } = await pool.query(
      'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING *',
      [nombre, precio, stockVal]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
