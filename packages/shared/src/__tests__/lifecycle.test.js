'use strict';

const { createLifecycle, isDraining, setDraining } = require('../lifecycle');

function fakeServer(closeImpl) {
  return {
    close: jest.fn(closeImpl || (cb => cb())),
    closeIdleConnections: jest.fn(),
    closeAllConnections: jest.fn(),
  };
}

describe('coordinated lifecycle', () => {
  beforeEach(() => {
    setDraining(false);
  });

  it('marks draining, stops workers, closes HTTP and the pool', async () => {
    const order = [];
    const server = fakeServer(cb => {
      order.push('server');
      cb();
    });
    const pool = {
      end: jest.fn(async () => {
        order.push('pool');
      }),
    };
    const stop = jest.fn(() => {
      order.push('worker');
    });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const lifecycle = createLifecycle({
      service: 'test',
      logger,
      server,
      pool,
      onShutdown: [stop],
      timeoutMs: 1000,
    });

    expect(isDraining()).toBe(false);
    await lifecycle.shutdown('SIGTERM');

    expect(isDraining()).toBe(true);
    expect(stop).toHaveBeenCalledWith('SIGTERM');
    expect(order).toEqual(['worker', 'server', 'pool']);
    expect(logger.info).toHaveBeenCalledWith('shutdown_complete', expect.any(Object));
  });

  it('is idempotent when called twice', async () => {
    const pool = { end: jest.fn(async () => {}) };
    const lifecycle = createLifecycle({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      server: fakeServer(),
      pool,
      timeoutMs: 1000,
    });

    const first = await lifecycle.shutdown('SIGTERM');
    const second = await lifecycle.shutdown('SIGTERM');

    expect(first.alreadyShuttingDown).toBe(false);
    expect(second.alreadyShuttingDown).toBe(true);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('forces connections closed after the timeout', async () => {
    const server = fakeServer(() => {
      // Never calls the callback: simulates a stuck keep-alive connection.
    });
    const lifecycle = createLifecycle({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      server,
      pool: { end: async () => {} },
      timeoutMs: 20,
    });

    await lifecycle.shutdown('SIGINT');

    expect(server.closeAllConnections).toHaveBeenCalled();
  });
});
