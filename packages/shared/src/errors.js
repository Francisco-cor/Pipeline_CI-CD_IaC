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

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
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

module.exports = { AppError, errorHandler, notFoundHandler };
