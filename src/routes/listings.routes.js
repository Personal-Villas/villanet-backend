import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';

const r = Router();

/**
 * GET /listings
 * Con caché inteligente
 */
r.get('/', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const {
      q = '',
      bedrooms = '',
      bathrooms = '',
      minPrice = '',
      maxPrice = '',
      limit = '24',
      offset = '0',
      sort = 'updated_desc'
    } = req.query;

    // 🔑 Genera una clave única basada en los parámetros de búsqueda
    // Normalizamos para que "bedrooms=2,3" y "bedrooms=3,2" sean la misma clave
    const normalizedQuery = {
      q: q.trim().toLowerCase(),
      bedrooms: bedrooms.split(',').filter(Boolean).sort().join(','),
      bathrooms: bathrooms.split(',').filter(Boolean).sort().join(','),
      minPrice: minPrice || '',
      maxPrice: maxPrice || '',
      limit,
      offset,
      sort
    };
    
    const cacheKey = `listings:${JSON.stringify(normalizedQuery)}`;

    // 🎯 Intenta obtener del caché
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`[Cache HIT] ${cacheKey}`);
      return res.json(cached);
    }

    console.log(`[Cache MISS] ${cacheKey}`);

    // --- Tu código original de consulta a la BD ---
    const clauses = [];
    const params = [];

    const qNorm = q.trim().toLowerCase();
    if (qNorm.length >= 3) {
      params.push(`%${qNorm}%`);
      const idx = params.length;
      clauses.push(`(
        LOWER(name) ILIKE $${idx} OR 
        LOWER(location_text) ILIKE $${idx} OR 
        LOWER(city) ILIKE $${idx} OR 
        LOWER(country) ILIKE $${idx}
      )`);
    }

    const bedroomsList = bedrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bedroomsList.length) {
      const nums = bedroomsList.filter(v => /^\d+$/.test(v)).map(Number);
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

    const bathroomsList = bathrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bathroomsList.length) {
      const nums = bathroomsList.filter(v => /^\d+$/.test(v)).map(Number);
      const has5plus = bathroomsList.includes('5+');

      const parts = [];
      if (nums.length) {
        params.push(nums);
        parts.push(`bathrooms = ANY($${params.length}::int[])`);
      }
      if (has5plus) parts.push(`bathrooms >= 5`);
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
    }

    if (minPrice) {
      params.push(Number(minPrice));
      clauses.push(`price_usd >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      clauses.push(`price_usd <= $${params.length}`);
    }

    clauses.push(`is_listed = true`);
    clauses.push(`(images_json IS NOT NULL AND images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    let orderSQL = `ORDER BY updated_at DESC`;
    if (sort === 'price_asc') orderSQL = `ORDER BY price_usd ASC NULLS LAST, updated_at DESC`;
    else if (sort === 'price_desc') orderSQL = `ORDER BY price_usd DESC NULLS LAST, updated_at DESC`;

    const lim = Math.min(Math.max(parseInt(String(limit), 10) || 24, 1), 100);
    const off = Math.max(parseInt(String(offset), 10) || 0, 0);
    params.push(lim);
    params.push(off);

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
        hero_image_url as "heroImage",
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
      pool.query(countSQL, params.slice(0, params.length - 2))
    ]);

    const result = {
      results: rowsResult.rows,
      total: countResult.rows[0].total,
      limit: lim,
      offset: off,
      hasMore: off + rowsResult.rows.length < countResult.rows[0].total
    };

    // 💾 Guarda en caché (5 minutos por defecto)
    cache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    console.error('Listings DB error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listings' });
  }
});

/**
 * GET /listings/:id
 * También con caché
 */
r.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `listing:${id}`;

    // Intenta obtener del caché
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`[Cache HIT] ${cacheKey}`);
      return res.json(cached);
    }

    console.log(`[Cache MISS] ${cacheKey}`);

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

    if (!rows.length) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    const result = rows[0];

    // Guarda en caché (10 minutos para detalles individuales)
    cache.set(cacheKey, result, 600);

    res.json(result);
  } catch (err) {
    console.error('Listing detail DB error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listing detail' });
  }
});

export default r;