const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /stock - list all stock movements
// Returns up to 50 most recent movements, newest first.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM movimientos_stock ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /stock - create a stock movement
// Fields: producto_id (required), cantidad (required), tipo (required: 'entrada' | 'salida')
router.post('/', async (req, res) => {
  const { producto_id, cantidad, tipo } = req.body;
  if (!producto_id || cantidad == null || !tipo) {
    return res.status(400).json({ error: 'producto_id, cantidad, and tipo are required' });
  }
  if (!['entrada', 'salida'].includes(tipo)) {
    return res.status(400).json({ error: "tipo must be 'entrada' or 'salida'" });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO movimientos_stock (producto_id, cantidad, tipo) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, tipo]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
