'use strict';

// SPDX-License-Identifier: MIT
// Barrel export — facilita `require('@erp/shared')`

const pool = require('./db');
const logger = require('./logger');

module.exports = {
  // logger
  createLogger: logger.createLogger,
  logger: logger.logger || logger,
  info: logger.info,
  warn: logger.warn,
  error: logger.error,

  // db
  pool,
  createPool: pool.createPool,
};
