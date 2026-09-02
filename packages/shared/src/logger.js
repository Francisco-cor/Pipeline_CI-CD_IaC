'use strict';

// SPDX-License-Identifier: MIT
// Shared structured logger — JSON lines to stdout for CloudWatch.
// Fase 2: unifica los 3 logger.js duplicados (productos, ordenes, stock).
// Fase 9.1: correlation-id via AsyncLocalStorage — requestId automático

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function getRequestId() {
  const store = storage.getStore();
  return store ? store.requestId : null;
}

function runWithRequestId(requestId, fn) {
  return storage.run({ requestId }, fn);
}

/**
 * Crea un logger con service fijo. Si no se pasa, usa SERVICE_NAME env.
 * @param {string} [serviceName]
 */
function createLogger(serviceName) {
  const svc = serviceName || process.env.SERVICE_NAME || 'unknown';

  const log = (level, message, extra = {}) => {
    const requestId = extra.requestId || getRequestId();
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service: svc,
      message,
      ...(requestId ? { requestId } : {}),
      ...extra,
    };
    // Evita duplicar requestId si ya está en extra
    if (requestId && extra.requestId) delete payload.requestId;
    if (requestId) payload.requestId = requestId;
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    _log: log,
  };
}

// Default singleton para compatibilidad: usa SERVICE_NAME del env en cada llamada
const defaultLogger = createLogger();

module.exports = {
  createLogger,
  ...defaultLogger,
  // También exportar como objeto para desestructurar: const { logger } = require('@erp/shared')
  logger: defaultLogger,
  storage,
  getRequestId,
  runWithRequestId,
};
