-- Pre-populate the database with industrial components (BOM)
-- These components are typical for a manufacturing ERP system
--
-- This script is idempotent: it only inserts if the product name (nombre)
-- does not already exist.

INSERT INTO productos (nombre, precio, stock)
SELECT 'Motor Trifásico 5HP mod. M3000', 850.50, 12
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Motor Trifásico 5HP mod. M3000');

INSERT INTO productos (nombre, precio, stock)
SELECT 'PLC Siemens S7-1200 CPU 1214C', 420.00, 8
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'PLC Siemens S7-1200 CPU 1214C');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Sensor Láser de Proximidad 24V', 75.25, 45
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Sensor Láser de Proximidad 24V');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Actuador Neumático Doble Efecto', 135.00, 20
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Actuador Neumático Doble Efecto');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Variador de Frecuencia 15kW G120', 1200.00, 5
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Variador de Frecuencia 15kW G120');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Panel HMI KTP700 Basic', 680.00, 3
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Panel HMI KTP700 Basic');
