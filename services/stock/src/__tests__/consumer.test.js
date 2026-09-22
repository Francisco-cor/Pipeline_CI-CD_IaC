'use strict';

const { handleQueueEvent } = require('../consumer');

function fakeClient({ productRows = [{ id: 7 }] } = {}) {
  return {
    query: jest.fn(async sql => {
      if (sql.includes('SELECT id FROM productos')) return { rows: productRows };
      if (sql.includes('INSERT INTO movimientos_stock')) {
        return { rows: [{ id: 12, producto_id: 7, cantidad: 2, tipo: 'salida' }] };
      }
      if (sql.includes('INSERT INTO outbox_events')) return { rows: [{ event_id: 'event-id' }] };
      return { rows: [] };
    }),
  };
}

describe('stock queue consumer', () => {
  it('turns an order event into one stock movement and outbound event', async () => {
    const client = fakeClient();

    await handleQueueEvent(
      { event: 'orden.creada', data: { producto_id: 7, cantidad: 2 } },
      client
    );

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [7]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('movimientos_stock'), [7, 2]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('outbox_events'),
      expect.any(Array)
    );
  });

  it('ignores events owned by another consumer', async () => {
    const client = fakeClient();
    await handleQueueEvent({ event: 'stock.actualizado', data: {} }, client);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects invalid and unknown products so SQS can retry/DLQ them', async () => {
    await expect(
      handleQueueEvent(
        { event: 'orden.creada', data: { producto_id: 0, cantidad: 1 } },
        fakeClient()
      )
    ).rejects.toThrow('payload is invalid');

    await expect(
      handleQueueEvent(
        { event: 'orden.creada', data: { producto_id: 7, cantidad: 1 } },
        fakeClient({ productRows: [] })
      )
    ).rejects.toThrow('not found');
  });
});
