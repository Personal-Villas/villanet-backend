import { Router } from 'express';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import { getAvailabilityFor } from '../services/availability.service.js';

const r = Router();

// Configuración
const BULK_AVAILABILITY_FETCH_SIZE = 200;
const MAX_AVAILABILITY_SESSION_SIZE = 1000;
const AVAILABILITY_SESSION_TTL = 300000; // 5 minutos

/**
 * GET /public/listings
 * ENDPOINT PÚBLICO - No requiere autenticación
 */
r.get('/', async (req, res) => {
  try {
    const {
      q = '',
      bedrooms = '',
      bathrooms = '',
      minPrice = '',
      maxPrice = '',
      checkIn = '',
      checkOut = '',
      badges = '', 
      limit = '24',
      offset = '0',
      sort = 'updated_desc',
      availabilitySession = '',
      availabilityCursor = '0'
    } = req.query;

    const lim = Math.min(Math.max(parseInt(String(limit), 10) || 24, 1), 100);
    const off = Math.max(parseInt(String(offset), 10) || 0, 0);
    const cursor = parseInt(availabilityCursor) || 0;
    const hasAvailabilityFilter = checkIn && checkOut;

    // Validación de disponibilidad
    if (hasAvailabilityFilter) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(checkIn) || !dateRegex.test(checkOut)) {
        return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
      }
      if (new Date(checkOut) <= new Date(checkIn)) {
        return res.status(400).json({ message: 'Check-out must be after check-in' });
      }
    }

    // Cache key
    const normalizedQuery = {
      q: q.trim().toLowerCase(),
      bedrooms: bedrooms.split(',').filter(Boolean).sort().join(','),
      bathrooms: bathrooms.split(',').filter(Boolean).sort().join(','),
      minPrice: minPrice || '',
      maxPrice: maxPrice || '',
      checkIn: checkIn || '',
      checkOut: checkOut || '',
      badges: badges.split(',').filter(Boolean).sort().join(','),
      limit,
      offset,
      sort
    };
    const cacheKey = `public:listings:${JSON.stringify(normalizedQuery)}`;

    // Construcción de filtros SQL
    const clauses = [];
    const params = [];

    // Búsqueda por texto
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

    // Convertir slugs de badges a IDs
    const badgeSlugs = badges.split(',').filter(Boolean);
    let badgeIds = [];
    
    if (badgeSlugs.length > 0) {
      const badgeQuery = await pool.query(
        `SELECT id FROM badges WHERE slug = ANY($1::text[])`,
        [badgeSlugs]
      );
      badgeIds = badgeQuery.rows.map(row => row.id);
    }

    // Filtro por badges
    if (badgeIds.length > 0) {
      params.push(badgeIds);
      clauses.push(`EXISTS (
        SELECT 1 FROM property_badges pb 
        WHERE pb.property_id = l.listing_id 
        AND pb.badge_id = ANY($${params.length}::bigint[])
      )`);
    }

    // Bedrooms
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

    // Bathrooms
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

    // Price
    if (minPrice) {
      params.push(Number(minPrice));
      clauses.push(`price_usd >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      clauses.push(`price_usd <= $${params.length}`);
    }

    // Filtros base: listadas y con imágenes
    clauses.push(`is_listed = true`);
    clauses.push(`(images_json IS NOT NULL AND images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Ordenamiento
    let orderSQL = `ORDER BY updated_at DESC`;
    if (sort === 'price_asc') orderSQL = `ORDER BY price_usd ASC NULLS LAST, updated_at DESC`;
    else if (sort === 'price_desc') orderSQL = `ORDER BY price_usd DESC NULLS LAST, updated_at DESC`;

    // Estrategia de disponibilidad (igual que antes)
    if (hasAvailabilityFilter && availabilitySession) {
      const availableIds = cache.get(availabilitySession);
      
      if (availableIds && Array.isArray(availableIds)) {
        const startIdx = cursor;
        const batchIds = availableIds.slice(startIdx, startIdx + lim);
        
        if (batchIds.length > 0) {
          let detailsSQL = `
            SELECT 
              l.listing_id as id,
              l.name,
              l.bedrooms,
              l.bathrooms, 
              l.price_usd as "priceUSD",
              l.location_text as location,
              l.city, 
              l.country, 
              COALESCE(l.hero_image_url, '') as "heroImage",
              COALESCE(l.images_json, '[]'::jsonb) as images_json,  
              l.updated_at
            FROM listings l
            WHERE l.listing_id = ANY($1)
          `;
          
          if (badgeIds.length > 0) {
            detailsSQL += ` AND EXISTS (
              SELECT 1 FROM property_badges pb 
              WHERE pb.property_id = l.listing_id 
              AND pb.badge_id = ANY($2::bigint[])
            )`;
          }
          
          detailsSQL += ` ORDER BY array_position($1, l.listing_id)`;
          
          const queryParams = badgeIds.length > 0 ? [batchIds, badgeIds] : [batchIds];
          const detailsResult = await pool.query(detailsSQL, queryParams);
          const results = detailsResult.rows;
          
          const nextCursor = startIdx + results.length;
          const hasMore = nextCursor < availableIds.length;
          
          const normalized = normalizeResults(results);
          
          return res.json({
            results: normalized,
            total: availableIds.length,
            limit: lim,
            offset: nextCursor,
            hasMore,
            availabilityApplied: true,
            availabilitySession: hasMore ? availabilitySession : null,
            availabilityCursor: hasMore ? nextCursor : null
          });
        }
      }
    }

    // Consulta masiva inicial de disponibilidad
    if (hasAvailabilityFilter && !availabilitySession) {
      const bulkFetchLimit = Math.min(BULK_AVAILABILITY_FETCH_SIZE, MAX_AVAILABILITY_SESSION_SIZE);
      
      const bulkParams = [...params];
      bulkParams.push(bulkFetchLimit);
      bulkParams.push(off);

      const bulkSQL = `
        SELECT l.listing_id as id
        FROM listings l
        ${whereSQL}
        ${orderSQL}
        LIMIT $${bulkParams.length-1} OFFSET $${bulkParams.length};
      `;

      const bulkResult = await pool.query(bulkSQL, bulkParams);
      const candidateIds = bulkResult.rows.map(r => r.id);

      if (candidateIds.length > 0) {
        try {
          const availability = await getAvailabilityFor(candidateIds, checkIn, checkOut);
          const availableIds = availability
            .filter(a => a.available === true)
            .map(a => a.listing_id);
          
          const availabilitySessionKey = `avail_session:${checkIn}:${checkOut}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
          cache.set(availabilitySessionKey, availableIds, AVAILABILITY_SESSION_TTL);
          
          const firstBatchIds = availableIds.slice(0, lim);
          
          if (firstBatchIds.length > 0) {
            let detailsSQL = `
              SELECT 
                l.listing_id as id,
                l.name,
                l.bedrooms,
                l.bathrooms, 
                l.price_usd as "priceUSD",
                l.location_text as location,
                l.city, 
                l.country, 
                COALESCE(l.hero_image_url, '') as "heroImage",
                COALESCE(l.images_json, '[]'::jsonb) as images_json,  
                l.updated_at
              FROM listings l
              WHERE l.listing_id = ANY($1)
            `;
            
            if (badgeIds.length > 0) {
              detailsSQL += ` AND EXISTS (
                SELECT 1 FROM property_badges pb 
                WHERE pb.property_id = l.listing_id 
                AND pb.badge_id = ANY($2::bigint[])
              )`;
            }
            
            detailsSQL += ` ORDER BY array_position($1, l.listing_id)`;
            
            const queryParams = badgeIds.length > 0 ? [firstBatchIds, badgeIds] : [firstBatchIds];
            const detailsResult = await pool.query(detailsSQL, queryParams);
            const results = detailsResult.rows;
            
            const nextCursor = firstBatchIds.length;
            const hasMore = nextCursor < availableIds.length;
            
            const normalized = normalizeResults(results);
            
            return res.json({
              results: normalized,
              total: availableIds.length,
              limit: lim,
              offset: nextCursor,
              hasMore,
              availabilityApplied: true,
              availabilitySession: hasMore ? availabilitySessionKey : null,
              availabilityCursor: hasMore ? nextCursor : null
            });
          }
        } catch (err) {
          console.error('[Public API] Availability check failed:', err);
        }
      }
    }

    // Estrategia estándar
    const standardParams = [...params];
    standardParams.push(lim);
    standardParams.push(off);

    const sql = `
      SELECT 
        l.listing_id as id,
        l.name,
        l.bedrooms,
        l.bathrooms, 
        l.price_usd as "priceUSD",
        l.location_text as location,
        l.city, 
        l.country, 
        COALESCE(l.hero_image_url, '') as "heroImage",
        COALESCE(l.images_json, '[]'::jsonb) as images_json,  
        l.updated_at
      FROM listings l
      ${whereSQL}
      ${orderSQL}
      LIMIT $${standardParams.length-1} OFFSET $${standardParams.length};
    `;

    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings l
      ${whereSQL};
    `;

    const [rowsResult, countResult] = await Promise.all([
      pool.query(sql, standardParams),
      pool.query(countSQL, standardParams.slice(0, standardParams.length - 2))
    ]);

    const results = rowsResult.rows;
    const totalInDB = countResult.rows[0].total;
    const hasMore = off + lim < totalInDB;

    const normalized = normalizeResults(results);

    const response = {
      results: normalized,
      total: totalInDB,
      limit: lim,
      offset: off,
      hasMore,
      availabilityApplied: false
    };

    if (!hasAvailabilityFilter) {
      cache.set(cacheKey, response, 300000);
    }
    
    res.json(response);
  } catch (err) {
    console.error('[Public API] Listings error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listings' });
  }
});

/**
 * GET /public/listings/:id
 * ENDPOINT PÚBLICO - Muestra detalles básicos, pero requiere login para booking
 */
r.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `public:listing:${id}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

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
      WHERE listing_id = $1 AND is_listed = true`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    const result = rows[0];
    cache.set(cacheKey, result, 600000);
    res.json(result);
  } catch (err) {
    console.error('[Public API] Listing detail error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listing detail' });
  }
});

function normalizeResults(results) {
  const PLACEHOLDER = 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80&auto=format&fit=crop';
  
  return results.map((item) => {
    const images = Array.isArray(item.images_json) ? item.images_json : [];
    const first = images[0];
    
    return {
      ...item,
      id: item.id || `temp-${Math.random().toString(36).slice(2)}`,
      images_json: images,
      heroImage: (typeof first === 'string' && first) || item.heroImage || PLACEHOLDER,
    };
  });
}

export default r;