import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';

const r = Router();

/**
 * GET /listings
 * Params (query):
 *  - q: string (3+ chars) -> busca en name / location_text / city / country (usa trigram si está habilitado)
 *  - bedrooms: ej "2,3,5+" (múltiples valores)
 *  - bathrooms: ej "2,3,5+" (múltiples valores)
 *  - minPrice / maxPrice: números (USD)
 *  - limit: default 30 (máx 100)
 *  - offset: default 0
 *  - sort: "price_asc" | "price_desc" | "updated_desc" (default)
 */
r.get('/', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const {
      q = '',
      bedrooms = '',
      bathrooms = '',
      minPrice = '',
      maxPrice = '',
      limit = '30',
      offset = '0',
      sort = 'updated_desc'
    } = req.query;

    const clauses = [];
    const params = [];

    // Búsqueda (usa trigram si tenés pg_trgm + índice)
    const qNorm = q.trim().toLowerCase();
    if (qNorm.length >= 3) {
      params.push(`%${qNorm}%`);
      const idx = params.length;
      clauses.push(`(LOWER(name) ILIKE $${idx} OR LOWER(location_text) ILIKE $${idx} OR LOWER(city) ILIKE $${idx} OR LOWER(country) ILIKE $${idx})`);
    }

    // Bedrooms: admite números y "5+" / "6+" (>=5 / >=6)
    const bedroomsList = bedrooms
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (bedroomsList.length) {
      const nums = bedroomsList.filter(v => /^\d+$/.test(v)).map(v => Number(v));
      const has5plus = bedroomsList.includes('5+');
      const has6plus = bedroomsList.includes('6+');

      const parts = [];
      if (nums.length) {
        params.push(nums);
        parts.push(`bedrooms = ANY($${params.length}::int[])`);
      }
      if (has6plus) parts.push(`bedrooms >= 6`);
      else if (has5plus) parts.push(`bedrooms >= 5`);
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
    }

    // Bathrooms: idem bedrooms
    const bathroomsList = bathrooms
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (bathroomsList.length) {
      const nums = bathroomsList.filter(v => /^\d+$/.test(v)).map(v => Number(v));
      const has5plus = bathroomsList.includes('5+');

      const parts = [];
      if (nums.length) {
        params.push(nums);
        parts.push(`bathrooms = ANY($${params.length}::int[])`);
      }
      if (has5plus) parts.push(`bathrooms >= 5`);
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
    }

    // Precio
    if (minPrice) {
      params.push(Number(minPrice));
      clauses.push(`price_usd >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      clauses.push(`price_usd <= $${params.length}`);
    }

    // ✅ FILTRO: Excluir propiedades inactivas (images_json vacío o null)
    clauses.push(`(images_json IS NOT NULL AND images_json != '[]'::jsonb)`);

    // WHERE
    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Orden
    let orderSQL = `ORDER BY updated_at DESC`;
    if (sort === 'price_asc') orderSQL = `ORDER BY price_usd ASC NULLS LAST`;
    else if (sort === 'price_desc') orderSQL = `ORDER BY price_usd DESC NULLS LAST`;
    else orderSQL = `ORDER BY updated_at DESC, price_usd ASC NULLS LAST`;

    // Paginación
    const lim = Math.min(Math.max(parseInt(String(limit), 10) || 30, 1), 100);
    const off = Math.max(parseInt(String(offset), 10) || 0, 0);
    params.push(lim);
    params.push(off);

    // ✅ Query principal CORREGIDO con aliases para el frontend
    const sql = `
      SELECT 
        listing_id as id,
        name,
        bedrooms,
        bathrooms, 
        price_usd as "priceUSD",
        location_text as location,
        city, 
        country, 
        min_nights, 
        is_listed, 
        timezone, 
        hero_image_url as "heroImage",
        images_json,
        updated_at
      FROM listings
      ${whereSQL}
      ${orderSQL}
      LIMIT $${params.length-1} OFFSET $${params.length};
    `;

    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings
      ${whereSQL};
    `;

    const [rowsResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSQL, params.slice(0, params.length - 2)) // mismos filtros, sin limit/offset
    ]);

    res.json({
      results: rowsResult.rows,
      total: countResult.rows[0].total,
      limit: lim,
      offset: off
    });
  } catch (err) {
    console.error('Listings DB error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listings' });
  }
});

/**
 * GET /listings/:id
 * Devuelve el registro de la tabla por primary key (listing_id)
 */
r.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT 
        listing_id,
        name, 
        bedrooms, 
        bathrooms, 
        price_usd as "price_usd",
        location_text,
        city, 
        country, 
        min_nights, 
        is_listed,
        timezone, 
        hero_image_url as "hero_image_url", 
        images_json,
        description,
        amenities_json as amenities, 
        updated_at
      FROM public.listings
      WHERE listing_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Listing not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Listing detail DB error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listing detail' });
  }
});

export default r;