'use strict';

// Re-export shared pool — elimina duplicación de db.js:3-19.
// Pool singleton creado en @erp/shared con SSL auto y max configurable.

module.exports = require('@erp/shared').pool;
