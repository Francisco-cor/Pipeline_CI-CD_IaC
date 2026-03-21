const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /ordenes - list all
// Returns up to 50 most recent orders, newest first.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM ordenes ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ordenes - create
// Fields: producto_id (required), cantidad (required), total (required)
// estado defaults to 'pendiente' at the DB level.
router.post('/', async (req, res) => {
  const { producto_id, cantidad, total } = req.body;
  if (!producto_id || cantidad == null || total == null) {
    return res.status(400).json({ error: 'producto_id, cantidad, and total are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO ordenes (producto_id, cantidad, total) VALUES ($1, $2, $3) RETURNING *',
      [producto_id, cantidad, total]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
