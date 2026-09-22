'use strict';

// SPDX-License-Identifier: MIT
// SQS transport plus the transactional outbox relay and inbox deduplication.

const { v5: uuidv5 } = require('uuid');

let sqsClient = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getQueueUrl() {
  return process.env.SQS_QUEUE_URL || process.env.ORDENES_QUEUE_URL || null;
}

function getSqsClient() {
  const url = getQueueUrl();
  if (!url) return null;
  if (sqsClient) return sqsClient;
  try {
    // eslint-disable-next-line import/no-unresolved, global-require
    const { SQSClient } = require('@aws-sdk/client-sqs');
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
    sqsClient = new SQSClient({ region });
  } catch (_e) {
    sqsClient = null;
  }
  return sqsClient;
}

async function sendMessage(payload) {
  const queueUrl = getQueueUrl();
  if (!queueUrl) return { messageId: 'noop', queueUrl: null };

  const client = getSqsClient();
  if (!client) throw new Error('SQS client unavailable');

  // eslint-disable-next-line import/no-unresolved, global-require
  const { SendMessageCommand } = require('@aws-sdk/client-sqs');
  const body = JSON.stringify(payload);
  const cmd = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
    MessageAttributes: {
      event: {
        DataType: 'String',
        StringValue: payload.event || payload.type || 'unknown',
      },
      event_id: {
        DataType: 'String',
        StringValue: payload.event_id || 'unknown',
      },
      service: {
        DataType: 'String',
        StringValue: process.env.SERVICE_NAME || 'unknown',
      },
    },
  });
  const res = await client.send(cmd);
  return { messageId: res.MessageId, queueUrl };
}

/**
 * Compatibility wrapper for callers that still publish directly.
 * New domain writes must use enqueue* + the outbox relay instead.
 */
async function publish(payload) {
  const logger = require('./logger');
  try {
    const result = await sendMessage(payload);
    logger.info('queue_publish_ok', {
      queueUrl: result.queueUrl,
      messageId: result.messageId,
      event: payload.event,
    });
    return result;
  } catch (err) {
    logger.error('queue_publish_failed', {
      queueUrl: getQueueUrl(),
      error: err.message,
      event: payload.event,
    });
    return { messageId: null, queueUrl: getQueueUrl(), error: err.message };
  }
}

// Deprecated compatibility helpers. They remain available for integrations;
// service routes use the transactional enqueue helpers exported by index.js.
async function publishOrdenCreada(orden) {
  return publish({
    event: 'orden.creada',
    timestamp: new Date().toISOString(),
    data: orden,
  });
}

async function publishStockActualizado(movimiento) {
  return publish({
    event: 'stock.actualizado',
    timestamp: new Date().toISOString(),
    data: movimiento,
  });
}

async function claimOutboxBatch(pool, limit, lockTimeoutSeconds) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT event_id
       FROM outbox_events
       WHERE published_at IS NULL
         AND available_at <= NOW()
         AND (locked_at IS NULL OR locked_at < NOW() - ($2 * INTERVAL '1 second'))
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events AS outbox
     SET locked_at = NOW(), attempts = outbox.attempts + 1
     FROM candidates
     WHERE outbox.event_id = candidates.event_id
     RETURNING outbox.*`,
    [limit, lockTimeoutSeconds]
  );
  return rows;
}

async function markOutboxPublished(pool, eventId) {
  await pool.query(
    `UPDATE outbox_events
     SET published_at = NOW(), locked_at = NULL, last_error = NULL
     WHERE event_id = $1`,
    [eventId]
  );
}

async function markOutboxFailed(pool, event, error) {
  const retrySeconds = Math.min(3600, 5 * 2 ** Math.min(Math.max(event.attempts - 1, 0), 8));
  await pool.query(
    `UPDATE outbox_events
     SET locked_at = NULL,
         available_at = NOW() + ($2 * INTERVAL '1 second'),
         last_error = $3
     WHERE event_id = $1`,
    [event.event_id, retrySeconds, String(error.message || error).slice(0, 2000)]
  );
}

async function relayOutboxBatch(pool, opts = {}) {
  const logger = require('./logger');
  const events = await claimOutboxBatch(pool, opts.batchSize ?? 10, opts.lockTimeoutSeconds ?? 60);

  for (const event of events) {
    try {
      await sendMessage(event.payload);
      await markOutboxPublished(pool, event.event_id);
      logger.info('outbox_publish_ok', {
        eventId: event.event_id,
        event: event.event_type,
        attempts: event.attempts,
      });
    } catch (err) {
      await markOutboxFailed(pool, event, err);
      logger.error('outbox_publish_failed', {
        eventId: event.event_id,
        event: event.event_type,
        attempts: event.attempts,
        error: err.message,
      });
    }
  }

  return events.length;
}

/**
 * Starts the durable outbox relay. It is enabled by default whenever SQS is
 * configured; OUTBOX_RELAY_ENABLED=false is an explicit emergency switch.
 */
function startOutboxRelay(pool, opts = {}) {
  if (!getQueueUrl() || process.env.OUTBOX_RELAY_ENABLED === 'false') return null;

  const logger = require('./logger');
  const pollInterval = opts.pollIntervalMs ?? Number(process.env.OUTBOX_POLL_MS || 5000);
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      await relayOutboxBatch(pool, opts);
    } catch (err) {
      logger.warn('outbox_poll_error', { error: err.message });
    } finally {
      if (!stopped) setTimeout(poll, pollInterval).unref?.();
    }
  }

  poll();
  logger.info('outbox_relay_started', { queueUrl: getQueueUrl() });
  return {
    stop() {
      stopped = true;
    },
  };
}

function stableEventId(body, messageId) {
  if (typeof body.event_id === 'string' && UUID_RE.test(body.event_id)) return body.event_id;
  return uuidv5(String(messageId || JSON.stringify(body)), uuidv5.URL);
}

async function processMessageIdempotently(pool, body, messageId, handler) {
  const eventId = stableEventId(body, messageId);
  const eventType = body.event || body.type || 'unknown';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO inbox_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType]
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { duplicate: true, eventId };
    }

    await handler(body, client);
    await client.query(
      'UPDATE inbox_events SET processed_at = NOW(), last_error = NULL WHERE event_id = $1',
      [eventId]
    );
    await client.query('COMMIT');
    return { duplicate: false, eventId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Long-poll consumer. A message is deleted only after the handler commits;
 * failures remain visible to SQS and eventually go to the configured DLQ.
 */
function startConsumer(handler, opts = {}) {
  const queueUrl = getQueueUrl();
  if (!queueUrl || process.env.POLL_SQS === 'false') return null;
  const client = getSqsClient();
  if (!client) return null;

  const logger = require('./logger');
  const pollInterval = opts.pollIntervalMs ?? 5000;
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      // eslint-disable-next-line import/no-unresolved, global-require
      const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
      const res = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 10,
          VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS) || 60,
          MessageAttributeNames: ['All'],
        })
      );

      for (const message of res.Messages || []) {
        try {
          const body = JSON.parse(message.Body);
          const result = opts.pool
            ? await processMessageIdempotently(opts.pool, body, message.MessageId, handler)
            : await handler(body);
          await client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })
          );
          logger.info(result?.duplicate ? 'queue_consume_duplicate' : 'queue_consume_ok', {
            messageId: message.MessageId,
            event: body.event,
          });
        } catch (err) {
          logger.error('queue_consume_handler_error', {
            messageId: message.MessageId,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.warn('queue_consume_poll_error', { error: err.message });
    } finally {
      if (!stopped) setTimeout(poll, pollInterval).unref?.();
    }
  }

  poll();
  logger.info('queue_consumer_started', { queueUrl });
  return {
    stop() {
      stopped = true;
    },
  };
}

module.exports = {
  publish,
  publishOrdenCreada,
  publishStockActualizado,
  startConsumer,
  startOutboxRelay,
  relayOutboxBatch,
  processMessageIdempotently,
  getQueueUrl,
};
