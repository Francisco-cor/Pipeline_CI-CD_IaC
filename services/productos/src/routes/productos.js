'use strict';

const {
  AppError,
  cache,
  parsePagination,
  productoSchema,
  setPaginationHeaders,
  sortToOrderBy,
  validate,
} = require('@erp/shared');
const express = require('express');

const pool = require('../db');

const router = express.Router();

// Fase 10.5 — cache key for productos list (incluye paginación + sort)
function productosCacheKey(page, limit, sort) {
  return `productos:list:${page}:${limit}:${sort}`;
}

// GET /productos — paginated (Fase 3.7) + cache Redis/memory (Fase 10.5)
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset, sort } = parsePagination(req);
    const orderBy = sortToOrderBy(sort);

    // Si cache está deshabilitado (CACHE_ENABLED=false) skip
    const cacheEnabled = process.env.CACHE_ENABLED !== 'false';
    if (cacheEnabled) {
      const key = productosCacheKey(page, limit, sort);
      const cached = await cache.get(key);
      if (cached) {
        setPaginationHeaders(res, req, page, limit, cached.total);
        res.set('X-Cache', 'HIT');
        return res.json(cached.body);
      }
    }

    // Total count for headers
    const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM productos');
    const total = totalResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT * FROM productos ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    setPaginationHeaders(res, req, page, limit, total);

    const body = {
      data: rows,
      count: rows.length, // compat
      total,
      page,
      limit,
    };

    if (cacheEnabled) {
      const key = productosCacheKey(page, limit, sort);
      await cache.set(key, { body, total }, Number(process.env.CACHE_TTL) || 30);
      res.set('X-Cache', 'MISS');
    }

    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /productos/:id — single (Fase 10.1 para ordenes HTTP)
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'id must be positive integer');
    }
    const cacheEnabled = process.env.CACHE_ENABLED !== 'false';
    const key = `productos:id:${id}`;
    if (cacheEnabled) {
      const cached = await cache.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: cached });
      }
    }
    const { rows } = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', `producto ${id} not found`);
    }
    if (cacheEnabled) {
      await cache.set(key, rows[0], Number(process.env.CACHE_TTL) || 30);
      res.set('X-Cache', 'MISS');
    }
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /productos — zod validation + fix falsy (Fase 3.3-3.4) + invalida cache (10.5)
router.post('/', validate(productoSchema), async (req, res, next) => {
  try {
    const { nombre, precio, stock } = req.body;
    const stockVal = stock ?? 0; // fix: stock || 0 breaks stock=0

    const { rows } = await pool.query(
      'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING *',
      [nombre, precio, stockVal]
    );
    // invalida cache list
    await cache.del('productos:list:*');
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /productos/:id — update + cache invalidate
router.put('/:id', validate(productoSchema), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'id must be positive integer');
    }
    const { nombre, precio, stock } = req.body;
    const { rows } = await pool.query(
      'UPDATE productos SET nombre=$1, precio=$2, stock=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [nombre, precio, stock ?? 0, id]
    );
    if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', `producto ${id} not found`);
    await cache.del('productos:list:*');
    await cache.del(`productos:id:${id}`);
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /productos/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'id must be positive integer');
    }
    const { rowCount } = await pool.query('DELETE FROM productos WHERE id=$1', [id]);
    if (rowCount === 0) throw new AppError(404, 'NOT_FOUND', `producto ${id} not found`);
    await cache.del('productos:list:*');
    await cache.del(`productos:id:${id}`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
