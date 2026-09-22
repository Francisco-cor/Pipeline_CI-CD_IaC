'use strict';

const { enqueueStockActualizado } = require('@erp/shared');

/**
 * Handles order events in the stock bounded context. The inbox transaction
 * supplied by queue.js also contains the movement and its outbound event.
 */
async function handleQueueEvent(message, client) {
  if (message.event !== 'orden.creada') return;

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

  const product = await client.query('SELECT id FROM productos WHERE id = $1 FOR UPDATE', [
    productoId,
  ]);
  if (product.rows.length === 0) throw new Error(`producto ${productoId} not found`);

  const { rows } = await client.query(
    `INSERT INTO movimientos_stock (producto_id, cantidad, tipo)
     VALUES ($1, $2, 'salida')
     RETURNING *`,
    [productoId, cantidad]
  );
  await enqueueStockActualizado(client, rows[0]);
}

module.exports = { handleQueueEvent };
