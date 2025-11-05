import { Router } from 'express';
import { pool } from '../db.js';         
import { auth } from '../middleware/auth.js'; 
import { requireRole } from '../middleware/requireRole.js';

const r = Router();

// GET /badges  => { categories:[], badges:[] }
r.get('/', auth(true), async (_req, res) => {
  const { rows: cats } = await pool.query(
    `SELECT slug, name, sort_order FROM badge_categories ORDER BY sort_order ASC`
  );
  const { rows: b } = await pool.query(
    `SELECT b.id, b.slug, b.name, c.slug AS category_slug, b.description, b.icon, b.is_dynamic
     FROM badges b
     JOIN badge_categories c ON c.id = b.category_id
     ORDER BY c.sort_order, b.name`
  );
  res.json({ categories: cats, badges: b });
});

// (Opcional) crear/editar/eliminar badges si querés panel de catálogo
r.post('/', auth(true), requireRole('admin'), async (req, res) => {
  const { slug, name, category_slug, description, icon, is_dynamic } = req.body || {};
  const cat = await pool.query(`SELECT id FROM badge_categories WHERE slug=$1`, [category_slug]);
  if (!cat.rowCount) return res.status(400).json({ message: 'Invalid category_slug' });

  const ins = await pool.query(
    `INSERT INTO badges(slug,name,category_id,description,icon,is_dynamic)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id, slug, name`,
    [slug, name, cat.rows[0].id, description||null, icon||null, !!is_dynamic]
  );
  res.status(201).json(ins.rows[0]);
});

export default r;
