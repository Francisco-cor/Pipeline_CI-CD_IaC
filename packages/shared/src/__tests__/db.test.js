'use strict';

jest.mock('pg', () => {
  const handlers = {};
  const pool = {
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    _handlers: handlers,
  };
  return { Pool: jest.fn(() => pool) };
});

const { Pool } = require('pg');

const { createPool } = require('../db');

describe('createPool', () => {
  it('sets statement, query and idle-transaction timeouts', () => {
    const pool = createPool({ connectionString: 'postgresql://local/test', max: 4 });
    const opts = Pool.mock.calls[Pool.mock.calls.length - 1][0];

    expect(pool).toBeDefined();
    expect(opts.statement_timeout).toBeGreaterThan(0);
    expect(opts.query_timeout).toBeGreaterThan(0);
    expect(opts.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    expect(opts.max).toBe(4);
  });

  it('logs idle client errors without exiting the process', () => {
    const previousExit = process.exit;
    process.exit = jest.fn();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const pool = createPool({ connectionString: 'postgresql://local/test' });
    const handler = pool._handlers.error;
    const brokenClient = { release: jest.fn() };
    handler(Object.assign(new Error('terminating connection'), { client: brokenClient }));

    expect(brokenClient.release).toHaveBeenCalledWith(true);
    expect(process.exit).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
    process.exit = previousExit;
  });
});
