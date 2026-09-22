'use strict';

const { processMessageIdempotently } = require('../queue');

function fakePool(queryResults) {
  const client = {
    query: jest.fn(async () => queryResults.shift() || { rows: [] }),
    release: jest.fn(),
  };
  return { pool: { connect: jest.fn(async () => client) }, client };
}

describe('SQS inbox idempotency', () => {
  it('commits the handler once and skips a redelivery', async () => {
    const first = fakePool([
      { rows: [] },
      { rows: [{ event_id: '11111111-1111-4111-8111-111111111111' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const handler = jest.fn(async () => {});

    const result = await processMessageIdempotently(
      first.pool,
      { event_id: '11111111-1111-4111-8111-111111111111', event: 'orden.creada' },
      'message-1',
      handler
    );

    expect(result.duplicate).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.client.query).toHaveBeenCalledWith('COMMIT');

    const second = fakePool([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const duplicate = await processMessageIdempotently(
      second.pool,
      { event_id: '11111111-1111-4111-8111-111111111111', event: 'orden.creada' },
      'message-1',
      handler
    );

    expect(duplicate.duplicate).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when the domain handler fails', async () => {
    const fake = fakePool([
      { rows: [] },
      { rows: [{ event_id: '22222222-2222-4222-8222-222222222222' }] },
      { rows: [] },
    ]);
    await expect(
      processMessageIdempotently(
        fake.pool,
        { event_id: '22222222-2222-4222-8222-222222222222', event: 'orden.creada' },
        'message-2',
        async () => {
          throw new Error('stock unavailable');
        }
      )
    ).rejects.toThrow('stock unavailable');

    expect(fake.client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
