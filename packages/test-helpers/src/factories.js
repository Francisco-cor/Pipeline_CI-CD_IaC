'use strict';

const { faker } = require('@faker-js/faker');

function productoFactory(overrides = {}) {
  return {
    nombre: overrides.nombre ?? faker.commerce.productName() + ' ' + faker.string.alphanumeric(4),
    precio: overrides.precio ?? Number(faker.commerce.price({ min: 1, max: 1000, dec: 2 })),
    stock: overrides.stock ?? faker.number.int({ min: 0, max: 100 }),
    ...overrides,
  };
}

function ordenFactory(overrides = {}) {
  return {
    producto_id: overrides.producto_id ?? 1,
    cantidad: overrides.cantidad ?? faker.number.int({ min: 1, max: 10 }),
    total: overrides.total ?? Number(faker.commerce.price({ min: 10, max: 500, dec: 2 })),
    ...overrides,
  };
}

function stockFactory(overrides = {}) {
  return {
    producto_id: overrides.producto_id ?? 1,
    cantidad: overrides.cantidad ?? faker.number.int({ min: 1, max: 20 }),
    tipo: overrides.tipo ?? faker.helpers.arrayElement(['entrada', 'salida']),
    ...overrides,
  };
}

module.exports = { productoFactory, ordenFactory, stockFactory, faker };
