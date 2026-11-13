'use strict';

// SPDX-License-Identifier: MIT
// Shared validation — Fase 3.3 con zod

const { z } = require('zod');

const { AppError } = require('./errors');

// NUMERIC(10,2) and INTEGER column bounds, validated before PostgreSQL sees them.
const MAX_MONEY = 99999999.99;
const MAX_INT = 2147483647;
const MAX_PAGE = 10000;

const precioSchema = z.coerce.number().finite().min(0).max(MAX_MONEY);
const cantidadSchema = z.coerce.number().int().min(1).max(MAX_INT);
const stockAmountSchema = z.coerce.number().int().min(0).max(MAX_INT);

// stock is the initial balance, not a mutable product field. Keeping it
// optional (instead of defaulting to 0) lets POST distinguish "no stock" from
// an explicit zero and lets PUT reject/ignore it without resetting the ledger.
const productoCreateSchema = z.object({
  nombre: z.string().min(1).max(255),
  precio: precioSchema,
  stock: stockAmountSchema.optional(),
});

const productoUpdateSchema = z.object({
  nombre: z.string().min(1).max(255),
  precio: precioSchema,
});

// Kept as a compatibility alias for callers that only create products.
const productoSchema = productoCreateSchema;

const ordenSchema = z.object({
  producto_id: z.coerce.number().int().positive().max(MAX_INT),
  cantidad: cantidadSchema,
  // Advisory only: the server computes total from productos.precio * cantidad.
  total: z.coerce.number().finite().min(0).max(MAX_MONEY).optional(),
});

const stockSchema = z.object({
  producto_id: z.coerce.number().int().positive().max(MAX_INT),
  cantidad: cantidadSchema,
  tipo: z.enum(['entrada', 'salida']),
});

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.enum(['created_at_asc', 'created_at_desc']).optional().default('created_at_desc'),
});

/**
 * Middleware factory para validar req[source] con zod schema.
 * @param {import('zod').ZodSchema} schema
 * @param {'body'|'query'|'params'} source
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed; // coerce applied
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const details = err.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        }));
        next(new AppError(400, 'VALIDATION_ERROR', 'validation failed', details));
      } else {
        next(err);
      }
    }
  };
}

module.exports = {
  z,
  MAX_MONEY,
  MAX_INT,
  MAX_PAGE,
  productoCreateSchema,
  productoUpdateSchema,
  productoSchema,
  ordenSchema,
  stockSchema,
  paginationQuerySchema,
  validate,
};
