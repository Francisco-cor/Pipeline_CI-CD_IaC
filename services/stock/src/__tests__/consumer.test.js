'use strict';

const { cache } = require('@erp/shared');

const { handleQueueEvent } = require('../consumer');

function fakeClient() {
  return { query: jest.fn() };
}

describe('stock queue consumer', () => {
  afterEach(() => {
    cache._resetForTests();
  });

  it('does not insert a second stock movement for an order', async () => {
    const client = fakeClient();

    const result = await handleQueueEvent(
      { event: 'orden.creada', data: { producto_id: 7, cantidad: 2 } },
      client
    );

    expect(result).toEqual({ handled: true, productoId: 7, cantidad: 2 });
    // The ordenes transaction already inserted the `salida` movement.
    expect(client.query).not.toHaveBeenCalled();
  });

  it('invalidates both product cache entries', async () => {
    await cache.set('productos:id:7', { id: 7, stock: 100 }, 30);
    await cache.set('productos:list:1:20:created_at_desc', { body: [], total: 0 }, 30);

    await handleQueueEvent(
      { event: 'orden.creada', data: { producto_id: 7, cantidad: 2 } },
      fakeClient()
    );

    expect(await cache.get('productos:id:7')).toBeNull();
    expect(await cache.get('productos:list:1:20:created_at_desc')).toBeNull();
  });

  it('ignores events owned by another consumer', async () => {
    const client = fakeClient();
    const result = await handleQueueEvent({ event: 'stock.actualizado', data: {} }, client);
    expect(result).toEqual({ handled: false });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads so SQS can retry/DLQ them', async () => {
    await expect(
      handleQueueEvent(
        { event: 'orden.creada', data: { producto_id: 0, cantidad: 1 } },
        fakeClient()
      )
    ).rejects.toThrow('payload is invalid');
  });
});
