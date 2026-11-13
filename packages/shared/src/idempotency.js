'use strict';

// SPDX-License-Identifier: MIT
// Idempotency-Key middleware for unsafe POST endpoints.
//
// Storage: idempotency_keys(scope, key) unique. The first request claims the
// key as `in_progress`; a duplicate waits briefly for the original response
// and then replays it. Same key + different body -> 409 IDEMPOTENCY_KEY_REUSED.
// 5xx responses release the key so the client can retry.
//
// TTL: rows are safe to delete after IDEMPOTENCY_TTL_HOURS (default 24h).
// This module exposes cleanupIdempotencyKeys(pool, opts) for a scheduled job;
// PostgreSQL cannot schedule it by itself. TTL is intentionally not enforced on
// read so old completed responses remain replayable until the cleanup runs.

const crypto = require('crypto');

const { AppError } = require('./errors');

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_TTL_HOURS = 24;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashBody(body) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(body === undefined ? null : body))
    .digest('hex');
}

/**
 * @param {object} opts
 * @param {string} opts.scope - logical endpoint, e.g. "ordenes:create"
 * @param {object} opts.pool - pg Pool
 * @param {number} [opts.waitMs] - max wait for a concurrent in-progress request
 * @returns {Function} express middleware
 */
function idempotency(opts) {
  const scope = opts.scope;
  const pool = opts.pool;
  const waitMs = opts.waitMs ?? 2000;
  if (!scope) throw new Error('idempotency requires a scope');
  if (!pool) throw new Error('idempotency requires a pool');

  async function claim(key, requestHash) {
    const { rows } = await pool.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status)
       VALUES ($1, $2, $3, 'in_progress')
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING id`,
      [scope, key, requestHash]
    );
    return rows.length > 0;
  }

  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!KEY_RE.test(key)) {
      return next(
        new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 1..200 safe characters')
      );
    }

    const requestHash = hashBody(req.body);
    let claimed;
    try {
      claimed = await claim(key, requestHash);
    } catch (err) {
      return next(err);
    }

    if (!claimed) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await pool.query(
          `SELECT request_hash, status, response_status, response_json
           FROM idempotency_keys WHERE scope = $1 AND key = $2`,
          [scope, key]
        );
        const row = rows[0];

        if (!row) {
          // The original failed with 5xx and released the key; try to claim it.
          // eslint-disable-next-line no-await-in-loop
          claimed = await claim(key, requestHash);
          if (claimed) break;
          continue;
        }

        if (row.request_hash !== requestHash) {
          return next(
            new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used with a different request body'
            )
          );
        }

        if (row.status === 'completed') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(row.response_status || 200).json(row.response_json);
        }

        if (Date.now() >= deadline) {
          res.set('Retry-After', '1');
          return next(
            new AppError(
              409,
              'IDEMPOTENCY_IN_PROGRESS',
              'A request with this Idempotency-Key is still in progress'
            )
          );
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    let captured = false;

    const persist = (status, body) => {
      const logger = require('./logger');
      const query =
        status >= 500
          ? pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key])
          : pool.query(
              `UPDATE idempotency_keys
                  SET status = 'completed',
                      response_status = $1,
                      response_json = $2::jsonb,
                      updated_at = NOW()
                WHERE scope = $3 AND key = $4`,
              [status, body === undefined ? null : JSON.stringify(body), scope, key]
            );
      return query.catch(err => {
        logger.warn('idempotency_persist_failed', { scope, error: err.message });
      });
    };

    const originalJson = res.json.bind(res);
    res.json = function jsonWithIdempotency(body) {
      if (captured) return originalJson(body);
      captured = true;
      const status = res.statusCode || 200;
      return persist(status, body).finally(() => originalJson(body));
    };

    // Fallback for handlers that end the response without res.json().
    res.on('finish', () => {
      if (captured) return;
      captured = true;
      persist(res.statusCode || 200, undefined);
    });

    return next();
  };
}

async function cleanupIdempotencyKeys(pool, opts = {}) {
  const ttlHours =
    opts.ttlHours ?? (Number(process.env.IDEMPOTENCY_TTL_HOURS) || DEFAULT_TTL_HOURS);
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys
      WHERE created_at < NOW() - ($1 * INTERVAL '1 hour')`,
    [ttlHours]
  );
  return rowCount;
}

module.exports = {
  idempotency,
  hashBody,
  stableStringify,
  cleanupIdempotencyKeys,
  DEFAULT_TTL_HOURS,
};
