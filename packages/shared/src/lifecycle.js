'use strict';

// SPDX-License-Identifier: MIT
// Coordinated process lifecycle: draining state, background worker stop,
// bounded HTTP server close and pool shutdown. No process.exit(): the event
// loop is left empty so Node exits on its own once all handles are closed.

const drainState = { draining: false };

function isDraining() {
  return drainState.draining;
}

function setDraining(value) {
  drainState.draining = Boolean(value);
}

function defaultLogger() {
  return {
    info: (message, meta) => console.error(JSON.stringify({ level: 'info', message, ...meta })),
    warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', message, ...meta })),
    error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.service]
 * @param {object} [opts.logger]
 * @param {object} [opts.server] - http.Server (or compatible fake)
 * @param {object} [opts.pool] - pg Pool
 * @param {Array<Function>} [opts.onShutdown] - stop consumers/relays/tracing
 * @param {number} [opts.timeoutMs]
 */
function createLifecycle(opts = {}) {
  const service = opts.service || process.env.SERVICE_NAME || 'service';
  const logger = opts.logger || defaultLogger();
  const server = opts.server;
  const pool = opts.pool;
  const hooks = opts.onShutdown || [];
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000);

  let shuttingDown = false;

  function closeServer() {
    if (!server || typeof server.close !== 'function') return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        logger.warn('shutdown_timeout', { service, timeoutMs });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        finish();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        server.close(finish);
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (_err) {
        finish();
      }
    });
  }

  async function shutdown(signal = 'SIGTERM') {
    if (shuttingDown) return { alreadyShuttingDown: true };
    shuttingDown = true;
    setDraining(true);
    logger.info('shutdown_started', { service, signal });

    for (const hook of hooks) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await hook(signal);
      } catch (err) {
        logger.warn('shutdown_hook_error', { service, error: err.message });
      }
    }

    await closeServer();

    if (pool && typeof pool.end === 'function') {
      try {
        await pool.end();
      } catch (err) {
        logger.warn('shutdown_pool_error', { service, error: err.message });
      }
    }

    logger.info('shutdown_complete', { service, signal });
    return { alreadyShuttingDown: false };
  }

  function install() {
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
  }

  return { shutdown, install, isDraining, setDraining };
}

module.exports = {
  createLifecycle,
  isDraining,
  setDraining,
};
