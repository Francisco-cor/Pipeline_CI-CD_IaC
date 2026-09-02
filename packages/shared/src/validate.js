'use strict';

// SPDX-License-Identifier: MIT
// Shared validation — Fase 3.3 con zod

const { z } = require('zod');

const { AppError } = require('./errors');

const productoSchema = z.object({
  nombre: z.string().min(1).max(255),
  precio: z.coerce.number().finite().min(0),
  stock: z.coerce.number().int().min(0).optional().default(0),
});

const ordenSchema = z.object({
  producto_id: z.coerce.number().int().positive(),
  cantidad: z.coerce.number().int().positive(),
  total: z.coerce.number().finite().min(0),
});

const stockSchema = z.object({
  producto_id: z.coerce.number().int().positive(),
  cantidad: z.coerce.number().int().positive(),
  tipo: z.enum(['entrada', 'salida']),
});

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
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
  productoSchema,
  ordenSchema,
  stockSchema,
  paginationQuerySchema,
  validate,
};
