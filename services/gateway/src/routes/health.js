'use strict';

const { createHealthRouter } = require('@erp/shared');

const pool = require('../db');
const logger = require('../logger');

module.exports = createHealthRouter({
  serviceName: 'svc-gateway',
  pool,
  logger,
});
