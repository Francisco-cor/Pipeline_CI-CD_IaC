'use strict';

const {
  MAX_INT,
  MAX_MONEY,
  MAX_PAGE,
  ordenSchema,
  productoCreateSchema,
  productoUpdateSchema,
} = require('../validate');

describe('domain validation bounds', () => {
  it('accepts an omitted initial stock but keeps explicit zero', () => {
    expect(productoCreateSchema.parse({ nombre: 'A', precio: 1 })).toEqual({
      nombre: 'A',
      precio: 1,
    });
    expect(productoCreateSchema.parse({ nombre: 'A', precio: 1, stock: 0 }).stock).toBe(0);
  });

  it('rejects impossible money and integer values', () => {
    expect(() => productoCreateSchema.parse({ nombre: 'A', precio: MAX_MONEY + 0.01 })).toThrow();
    expect(() =>
      productoCreateSchema.parse({ nombre: 'A', precio: 1, stock: MAX_INT + 1 })
    ).toThrow();
  });

  it('strips stock from the update payload', () => {
    const parsed = productoUpdateSchema.parse({ nombre: 'A', precio: 2, stock: 99 });
    expect(parsed).toEqual({ nombre: 'A', precio: 2 });
  });

  it('treats the order total as optional and bounded', () => {
    expect(ordenSchema.parse({ producto_id: 1, cantidad: 1 })).toEqual({
      producto_id: 1,
      cantidad: 1,
    });
    expect(() =>
      ordenSchema.parse({ producto_id: 1, cantidad: 1, total: MAX_MONEY + 1 })
    ).toThrow();
  });

  it('exports the page cap', () => {
    expect(MAX_PAGE).toBe(10000);
  });
});
