'use strict';

// Transactional outbox/inbox helpers. These functions deliberately accept a
// pg client so the caller controls the transaction boundary.

const { v4: uuidv4 } = require('uuid');

async function enqueueOutboxEvent(client, { event, aggregateType, aggregateId, data }) {
  const eventId = uuidv4();
  const payload = {
    event_id: eventId,
    event,
    timestamp: new Date().toISOString(),
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    data,
  };
  const dedupeKey = `${aggregateType}:${aggregateId}:${event}`;

  const { rows } = await client.query(
    `INSERT INTO outbox_events
       (event_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING event_id`,
    [eventId, event, aggregateType, aggregateId, dedupeKey, JSON.stringify(payload)]
  );

  return rows[0]?.event_id || eventId;
}

async function enqueueOrdenCreada(client, orden) {
  return enqueueOutboxEvent(client, {
    event: 'orden.creada',
    aggregateType: 'orden',
    aggregateId: orden.id,
    data: orden,
  });
}

async function enqueueStockActualizado(client, movimiento) {
  return enqueueOutboxEvent(client, {
    event: 'stock.actualizado',
    aggregateType: 'movimiento_stock',
    aggregateId: movimiento.id,
    data: movimiento,
  });
}

module.exports = {
  enqueueOutboxEvent,
  enqueueOrdenCreada,
  enqueueStockActualizado,
};
