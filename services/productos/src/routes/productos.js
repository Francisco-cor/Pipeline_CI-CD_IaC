'use strict';

const {
  AppError,
  ROLE_ADMINS,
  ROLE_WRITERS,
  cache,
  parsePagination,
  productoCreateSchema,
  productoUpdateSchema,
  requireRole,
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

// POST /productos — initial stock is an opening ledger entry, never a direct
// write to productos.stock. The 005 trigger remains the only writer of stock.
router.post(
  '/',
  requireRole(...ROLE_WRITERS),
  validate(productoCreateSchema),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { nombre, precio, stock = 0 } = req.body;

      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, 0) RETURNING *',
        [nombre, precio]
      );
      const producto = rows[0];

      if (stock > 0) {
        await client.query(
          `INSERT INTO movimientos_stock (producto_id, cantidad, tipo)
         VALUES ($1, $2, 'entrada')`,
          [producto.id, stock]
        );
      }

      // Re-read so the response reflects the stock updated by the trigger.
      const fresh = await client.query('SELECT * FROM productos WHERE id = $1', [producto.id]);
      await client.query('COMMIT');

      await cache.del('productos:list:*');
      res.status(201).json({ data: fresh.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  }
);

// PUT /productos/:id — metadata only. Stock changes exclusively through
// movimientos_stock (POST /stock, order reservation), so PUT cannot reset it.
router.put(
  '/:id',
  requireRole(...ROLE_WRITERS),
  validate(productoUpdateSchema),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'id must be positive integer');
      }
      const { nombre, precio } = req.body;
      const { rows } = await pool.query(
        'UPDATE productos SET nombre=$1, precio=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
        [nombre, precio, id]
      );
      if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', `producto ${id} not found`);
      await cache.del('productos:list:*');
      await cache.del(`productos:id:${id}`);
      res.json({ data: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /productos/:id
router.delete('/:id', requireRole(...ROLE_ADMINS), async (req, res, next) => {
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
