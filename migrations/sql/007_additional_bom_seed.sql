-- Fase 5.7: seed adicional — más componentes industriales, idempotente
-- Usa WHERE NOT EXISTS (compatible con 003) + ON CONFLICT si existe índice unique

INSERT INTO productos (nombre, precio, stock)
SELECT 'Rodamiento SKF 6205-2RS', 45.80, 60
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Rodamiento SKF 6205-2RS');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Bomba Hidráulica Bosch Rexroth A10VSO', 1250.00, 4
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Bomba Hidráulica Bosch Rexroth A10VSO');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Cable Profibus DP 2x0.64mm', 3.20, 200
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Cable Profibus DP 2x0.64mm');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Fuente Alimentación 24V 10A MDR-100', 85.00, 15
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Fuente Alimentación 24V 10A MDR-100');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Encoder Incremental 1024 PPR', 210.50, 9
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Encoder Incremental 1024 PPR');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Válvula Proporcional 4WRPEH', 980.00, 6
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Válvula Proporcional 4WRPEH');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Relé de Seguridad PNOZ s3', 165.75, 18
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Relé de Seguridad PNOZ s3');

INSERT INTO productos (nombre, precio, stock)
SELECT 'Módulo IO Digital SM 1221 16DI', 195.00, 11
WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Módulo IO Digital SM 1221 16DI');
