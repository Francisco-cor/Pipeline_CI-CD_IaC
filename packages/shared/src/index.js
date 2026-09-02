'use strict';

// SPDX-License-Identifier: MIT
// Barrel export — facilita `require('@erp/shared')`

const pool = require('./db');
const errors = require('./errors');
const logger = require('./logger');
const metrics = require('./metrics');
const middleware = require('./middleware');
const pagination = require('./pagination');
const tracing = require('./tracing');
const validate = require('./validate');

module.exports = {
  // logger (Fase 9.1 correlation-id)
  createLogger: logger.createLogger,
  logger: logger.logger || logger,
  info: logger.info,
  warn: logger.warn,
  error: logger.error,
  storage: logger.storage,
  getRequestId: logger.getRequestId,
  runWithRequestId: logger.runWithRequestId,

  // metrics (Fase 9.3)
  metricsMiddleware: metrics.metricsMiddleware,
  metricsHandler: metrics.metricsHandler,
  getRegistry: metrics.getRegistry,

  // tracing (Fase 9.6)
  initTracing: tracing.initTracing,
  shutdownTracing: tracing.shutdownTracing,

  // db
  pool,
  createPool: pool.createPool,

  // errors
  AppError: errors.AppError,
  errorHandler: errors.errorHandler,
  notFoundHandler: errors.notFoundHandler,

  // pagination
  parsePagination: pagination.parsePagination,
  setPaginationHeaders: pagination.setPaginationHeaders,
  sortToOrderBy: pagination.sortToOrderBy,

  // validate
  z: validate.z,
  validate: validate.validate,
  productoSchema: validate.productoSchema,
  ordenSchema: validate.ordenSchema,
  stockSchema: validate.stockSchema,
  paginationQuerySchema: validate.paginationQuerySchema,

  // middleware
  securityMiddleware: middleware.securityMiddleware,
  requestIdMiddleware: middleware.requestIdMiddleware,
};
