'use strict';

// SPDX-License-Identifier: MIT
// Barrel export — facilita `require('@erp/shared')`

const audit = require('./audit');
const auth = require('./auth');
const cache = require('./cache');
const circuitBreaker = require('./circuitBreaker');
const config = require('./config');
const pool = require('./db');
const diagnostics = require('./diagnostics');
const errors = require('./errors');
const health = require('./health');
const idempotency = require('./idempotency');
const lifecycle = require('./lifecycle');
const logger = require('./logger');
const metrics = require('./metrics');
const middleware = require('./middleware');
const outbox = require('./outbox');
const pagination = require('./pagination');
const queue = require('./queue');
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
  normalizeError: errors.normalizeError,

  // health / lifecycle
  createHealthRouter: health.createHealthRouter,
  createLifecycle: lifecycle.createLifecycle,
  isDraining: lifecycle.isDraining,
  setDraining: lifecycle.setDraining,

  // idempotency
  idempotency: idempotency.idempotency,
  cleanupIdempotencyKeys: idempotency.cleanupIdempotencyKeys,

  // pagination
  parsePagination: pagination.parsePagination,
  setPaginationHeaders: pagination.setPaginationHeaders,
  sortToOrderBy: pagination.sortToOrderBy,

  // validate
  z: validate.z,
  validate: validate.validate,
  productoCreateSchema: validate.productoCreateSchema,
  productoUpdateSchema: validate.productoUpdateSchema,
  productoSchema: validate.productoSchema,
  ordenSchema: validate.ordenSchema,
  stockSchema: validate.stockSchema,
  paginationQuerySchema: validate.paginationQuerySchema,

  // middleware
  securityMiddleware: middleware.securityMiddleware,
  requestIdMiddleware: middleware.requestIdMiddleware,
  createCorsOptions: middleware.createCorsOptions,

  // auth / RBAC (Fase 2 seguridad)
  authenticate: auth.authenticate,
  requireRole: auth.requireRole,
  requireScope: auth.requireScope,
  assertAuthConfig: auth.assertAuthConfig,
  verifyToken: auth.verifyToken,
  ROLE_READERS: auth.ROLE_READERS,
  ROLE_WRITERS: auth.ROLE_WRITERS,
  ROLE_ADMINS: auth.ROLE_ADMINS,

  // audit (Fase 2 seguridad)
  auditLog: audit.auditLog,

  // diagnostics gate (Fase 2 seguridad)
  requireDiagnostics: diagnostics.requireDiagnostics,

  // environment policy
  isProduction: config.isProduction,
  authEnabled: config.authEnabled,
  diagnosticsEnabled: config.diagnosticsEnabled,
  corsPolicy: config.corsPolicy,
  trustProxyValue: config.trustProxyValue,

  // cache (Fase 10.5)
  cache,
  // queue (Fase 10.6)
  queue,
  enqueueOutboxEvent: outbox.enqueueOutboxEvent,
  enqueueOrdenCreada: outbox.enqueueOrdenCreada,
  enqueueStockActualizado: outbox.enqueueStockActualizado,
  publishOrdenCreada: queue.publishOrdenCreada,
  publishStockActualizado: queue.publishStockActualizado,

  // circuit breaker (Fase 10.1)
  CircuitBreaker: circuitBreaker.CircuitBreaker,
  CircuitState: circuitBreaker.STATE,
};
