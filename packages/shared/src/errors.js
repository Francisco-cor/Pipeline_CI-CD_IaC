'use strict';

// SPDX-License-Identifier: MIT
// Shared error handling — Fase 3.6

class AppError extends Error {
  /**
   * @param {number} statusCode - HTTP status
   * @param {string} code - machine code (VALIDATION_ERROR, NOT_FOUND, etc.)
   * @param {string} message - human message
   * @param {any} [details] - extra details (zod issues)
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

const PG_ERRORS = {
  23505: [409, 'CONFLICT', 'resource already exists'],
  23503: [409, 'CONFLICT', 'referenced resource does not exist or is still in use'],
  23514: [400, 'VALIDATION_ERROR', 'value violates a database constraint'],
  '22P02': [400, 'VALIDATION_ERROR', 'invalid input syntax'],
  22003: [400, 'VALIDATION_ERROR', 'numeric value out of range'],
};

/**
 * Turns transport/PostgreSQL errors into operational AppErrors so clients get
 * a stable 4xx contract instead of a generic 500 "internal error".
 * @param {any} err
 * @returns {any}
 */
function normalizeError(err) {
  if (!err || err instanceof AppError) return err;

  // body-parser raises SyntaxError with type entity.parse.failed for invalid JSON.
  if (err.type === 'entity.parse.failed') {
    return new AppError(400, 'VALIDATION_ERROR', 'malformed JSON body');
  }
  if (err.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
  }

  if (err.code && PG_ERRORS[err.code]) {
    const [status, code, message] = PG_ERRORS[err.code];
    return new AppError(status, code, message, { pgCode: err.code });
  }

  // The stock invariant trigger raises a plain plpgsql exception.
  if (typeof err.message === 'string' && err.message.includes('stock insuficiente')) {
    return new AppError(409, 'STOCK_CONFLICT', err.message);
  }

  return err;
}

function errorHandler(rawErr, req, res, _next) {
  const err = normalizeError(rawErr);
  const status = err.statusCode || err.status || 500;
  const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN_ERROR');
  const message = err.isOperational ? err.message : 'internal error';
  const details = err.details || undefined;

  // Log 5xx as error, 4xx as warn
  const logger = require('./logger');
  const logFn = status >= 500 ? logger.error : logger.warn;
  logFn('request_error', {
    method: req.method,
    path: req.originalUrl || req.path,
    status,
    code,
    message: err.message,
    stack: status >= 500 ? err.stack : undefined,
    requestId: req.id,
  });

  // Never leak stack or pg details to client for 5xx
  const response = {
    error: {
      code,
      message: status >= 500 && !err.isOperational ? 'internal error' : message,
      ...(details ? { details } : {}),
      ...(req.id ? { requestId: req.id } : {}),
    },
  };

  res.status(status).json(response);
}

function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `route ${req.originalUrl} not found`));
}

module.exports = { AppError, errorHandler, notFoundHandler, normalizeError };
