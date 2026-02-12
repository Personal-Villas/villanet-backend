import { Router } from 'express';
import { pool } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const r = Router();

/**
 * NOTA: property_id referencia a listings.listing_id (TEXT)
 * Tu front llama /properties/:id/badges
 */

// GET /properties/:id/badges
r.get('/:id/badges', auth(true), async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(`
    SELECT 
      b.id, b.slug, b.name, c.slug AS category_slug, b.description, b.icon, b.is_dynamic,
      pb.value
    FROM property_badges pb
    JOIN badges b ON b.id = pb.badge_id
    JOIN badge_categories c ON c.id = b.category_id
    WHERE pb.property_id = $1
    ORDER BY c.sort_order, b.name
  `, [id]);

  rows
  .filter(r => 
    r.name !== 'Unknown' && 
    r.name !== 'Villas not verified' && 
    r.slug !== 'unknown'
  ) // 🔥 FILTRO CLAVE
  .map(r => ({
    badge: {
      id: r.id, 
      slug: r.slug, 
      name: r.name, 
      category_slug: r.category_slug,
      description: r.description, 
      icon: r.icon, 
      is_dynamic: r.is_dynamic
    },
    value: r.value || null
  }));
  res.json({ assignments });
});

// PUT /properties/:id/badges
r.put('/:id/badges', auth(true), requireRole('admin','pmc'), async (req, res) => {
  const { id } = req.params;
  const { assignments = [] } = req.body || {};

  const slugs = assignments.map(a => a.slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (slugs.length === 0) {
      await client.query(`DELETE FROM property_badges WHERE property_id=$1`, [id]);
      await client.query('COMMIT');
      return res.json({ ok: true, cleared: true });
    }

    const badgeRows = await client.query(
      `SELECT id, slug, is_dynamic FROM badges WHERE slug = ANY($1)`, [slugs]
    );
    if (badgeRows.rowCount !== slugs.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Unknown badge slug present' });
    }

    // elimina los que ya no vienen
    await client.query(
      `DELETE FROM property_badges 
       WHERE property_id=$1 AND badge_id NOT IN (SELECT id FROM badges WHERE slug = ANY($2))`,
      [id, slugs]
    );

    // upsert los nuevos/actualizados
    for (const b of badgeRows.rows) {
      const input = assignments.find(a => a.slug === b.slug);
      const val = b.is_dynamic ? (input?.value ?? null) : null;

      if (b.is_dynamic && (val === null || val === '')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: `Dynamic badge "${b.slug}" requires a value` });
      }

      await client.query(
        `INSERT INTO property_badges(property_id, badge_id, value)
         VALUES($1,$2,$3)
         ON CONFLICT (property_id, badge_id)
         DO UPDATE SET value=EXCLUDED.value, assigned_at=now()`,
        [id, b.id, val]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('property-badges upsert error:', e);
    res.status(500).json({ message: 'Failed to save badges' });
  } finally {
    client.release();
  }
});

export default r;
