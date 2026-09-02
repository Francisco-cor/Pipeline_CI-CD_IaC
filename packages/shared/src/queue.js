'use strict';

// SPDX-License-Identifier: MIT
// Fase 10.6 — Queue abstraction: SQS when SQS_QUEUE_URL + AWS creds, fallback to in-memory log
// Ordenes publica `orden.creada`, stock consume (polling opcional).
// Coste: SQS $0.40/millón msgs; si no configurado, no-op con logger.

let sqsClient = null;

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

/**
 * Publica evento en SQS (o log si no hay queue).
 * @param {object} payload - debe ser serializable
 * @param {object} [opts]
 * @param {string} [opts.messageGroupId]
 */
async function publish(payload, opts = {}) {
  const queueUrl = getQueueUrl();
  const logger = require('./logger');

  if (!queueUrl) {
    logger.info('queue_publish_noop', {
      queue: 'none',
      event: payload.event || payload.type || 'unknown',
      payload,
    });
    return { messageId: 'noop', queueUrl: null };
  }

  const client = getSqsClient();
  if (!client) {
    logger.warn('queue_publish_no_client', { queueUrl });
    return { messageId: null, queueUrl };
  }

  try {
    // eslint-disable-next-line import/no-unresolved, global-require
    const { SendMessageCommand } = require('@aws-sdk/client-sqs');
    const body = JSON.stringify(payload);
    const cmd = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageAttributes: {
        event: {
          DataType: 'String',
          StringValue: payload.event || 'unknown',
        },
        service: {
          DataType: 'String',
          StringValue: process.env.SERVICE_NAME || 'unknown',
        },
      },
      ...(opts.messageGroupId ? { MessageGroupId: opts.messageGroupId } : {}),
    });
    const res = await client.send(cmd);
    logger.info('queue_publish_ok', {
      queueUrl,
      messageId: res.MessageId,
      event: payload.event,
    });
    return { messageId: res.MessageId, queueUrl };
  } catch (err) {
    const logger2 = require('./logger');
    logger2.error('queue_publish_failed', {
      queueUrl,
      error: err.message,
      event: payload.event,
    });
    // No throw — publicar es best-effort para no romper orden; retry en DLQ futuro
    return { messageId: null, queueUrl, error: err.message };
  }
}

/**
 * Publica orden.creada — usado por ordenes tras INSERT exitoso.
 */
async function publishOrdenCreada(orden) {
  return publish({
    event: 'orden.creada',
    timestamp: new Date().toISOString(),
    data: orden,
  });
}

/**
 * Publica stock movimiento — usado por stock tras ajustar
 */
async function publishStockActualizado(movimiento) {
  return publish({
    event: 'stock.actualizado',
    timestamp: new Date().toISOString(),
    data: movimiento,
  });
}

/**
 * Consumidor simple polling para stock (opcional).
 * Si POLL_SQS=true y hay queue, hace long polling y llama handler por mensaje.
 * En ECS se ejecutaría como sidecar o en mismo proceso.
 * @param {(msg:any)=>Promise<void>} handler
 * @param {object} [opts]
 */
function startConsumer(handler, opts = {}) {
  const queueUrl = getQueueUrl();
  if (!queueUrl || process.env.POLL_SQS !== 'true') return null;
  const client = getSqsClient();
  if (!client) return null;
  const logger = require('./logger');
  let stopped = false;
  const pollInterval = opts.pollIntervalMs ?? 5000;

  async function poll() {
    if (stopped) return;
    try {
      // eslint-disable-next-line import/no-unresolved, global-require
      const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
      const cmd = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 10,
        MessageAttributeNames: ['All'],
      });
      const res = await client.send(cmd);
      if (res.Messages && res.Messages.length) {
        for (const m of res.Messages) {
          try {
            const body = JSON.parse(m.Body);
            // eslint-disable-next-line no-await-in-loop
            await handler(body);
            const del = new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle,
            });
            // eslint-disable-next-line no-await-in-loop
            await client.send(del);
            logger.info('queue_consume_ok', { messageId: m.MessageId, event: body.event });
          } catch (err) {
            logger.error('queue_consume_handler_error', {
              messageId: m.MessageId,
              error: err.message,
            });
          }
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
  getQueueUrl,
};
