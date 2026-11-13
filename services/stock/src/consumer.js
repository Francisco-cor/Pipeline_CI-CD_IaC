'use strict';

const { cache } = require('@erp/shared');

/**
 * Handles order events in the stock bounded context.
 *
 * Stock is already reserved by the ordenes transaction (one `salida` movement
 * inserted under the 005 trigger). This consumer must NOT insert another
 * movement: doing so would double-discount the order. It only invalidates the
 * productos cache so subsequent reads observe the reservation. The inbox
 * transaction in queue.js still makes redeliveries harmless.
 */
async function handleQueueEvent(message, _client) {
  if (message.event !== 'orden.creada') return { handled: false };

  const order = message.data || {};
  const productoId = Number(order.producto_id);
  const cantidad = Number(order.cantidad);
  if (
    !Number.isInteger(productoId) ||
    productoId <= 0 ||
    !Number.isInteger(cantidad) ||
    cantidad <= 0
  ) {
    throw new Error('orden.creada payload is invalid');
  }

  await cache.del(`productos:id:${productoId}`);
  await cache.del('productos:list:*');

  return { handled: true, productoId, cantidad };
}

module.exports = { handleQueueEvent };
