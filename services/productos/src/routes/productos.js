const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /productos - list all
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM productos ORDER BY created_at DESC LIMIT 50');
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /productos - create
router.post('/', async (req, res) => {
  const { nombre, precio, stock } = req.body;
  if (!nombre || precio == null) {
    return res.status(400).json({ error: 'nombre and precio are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING *',
      [nombre, precio, stock || 0]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
