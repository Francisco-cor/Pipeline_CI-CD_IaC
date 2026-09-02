'use strict';

// Re-export shared logger with service-specific instance.
// Fase 2: shared kernel — elimina duplicación de logger.js:7-17.

const { createLogger } = require('@erp/shared');

module.exports = createLogger('svc-productos');
