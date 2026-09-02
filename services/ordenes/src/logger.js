'use strict';

// Re-export shared logger with service-specific instance.

const { createLogger } = require('@erp/shared');

module.exports = createLogger('svc-ordenes');
