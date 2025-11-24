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
        LOWER(l.name) ILIKE $${idx} OR 
        LOWER(l.location_text) ILIKE $${idx} OR 
        LOWER(l.city) ILIKE $${idx} OR 
        LOWER(l.country) ILIKE $${idx}
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
        parts.push(`l.bedrooms = ANY($${params.length}::int[])`);
      }
      if (has6plus) parts.push(`l.bedrooms >= 6`);
      else if (has5plus) parts.push(`l.bedrooms >= 5`);
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
        parts.push(`l.bathrooms = ANY($${params.length}::int[])`);
      }
      if (has5plus) parts.push(`l.bathrooms >= 5`);
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
    }

    // Price
    if (minPrice) {
      params.push(Number(minPrice));
      clauses.push(`l.price_usd >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      clauses.push(`l.price_usd <= $${params.length}`);
    }

    // Filtros base: listadas y con imágenes
    clauses.push(`l.is_listed = true`);
    clauses.push(`(l.images_json IS NOT NULL AND l.images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // ✅ SOLUCIÓN DEFINITIVA: Ordenamiento SIN usar rank en absoluto
    let orderSQL = `ORDER BY l.updated_at DESC`;
    if (sort === 'price_asc') {
      orderSQL = `ORDER BY l.price_usd ASC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'price_desc') {
      orderSQL = `ORDER BY l.price_usd DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'rank') {
      // ✅ SOLUCIÓN: Usar un nombre completamente diferente para el cálculo
      orderSQL = `ORDER BY COALESCE(l."rank", 90 + random()*10) DESC NULLS LAST, l.updated_at DESC`;
    }

    // Estrategia de disponibilidad
    if (hasAvailabilityFilter && availabilitySession) {
      const availableIds = cache.get(availabilitySession);
      
      if (availableIds && Array.isArray(availableIds)) {
        const startIdx = cursor;
        const batchIds = availableIds.slice(startIdx, startIdx + lim);
        
        if (batchIds.length > 0) {
          const placeholders = batchIds.map((_, i) => `$${i + 1}`).join(',');
          
          let detailsSQL = `
            SELECT 
              l.listing_id as id,
              l.name,
              l.bedrooms,
              l.bathrooms, 
              l.price_usd as "priceUSD",
              COALESCE(l."rank", 90 + random()*10) as listing_score,
              l.location_text as location,
              l.city, 
              l.country, 
              COALESCE(l.hero_image_url, '') as "heroImage",
              COALESCE(l.images_json, '[]'::jsonb) as images_json,  
              l.updated_at
            FROM listings l
            WHERE l.listing_id IN (${placeholders})
          `;
          
          if (badgeIds.length > 0) {
            detailsSQL += ` AND EXISTS (
              SELECT 1 FROM property_badges pb 
              WHERE pb.property_id = l.listing_id 
              AND pb.badge_id = ANY($${batchIds.length + 1}::bigint[])
            )`;
          }
          
          detailsSQL += ` ORDER BY array_position(ARRAY[${placeholders}], l.listing_id)`;
          
          const queryParams = [...batchIds];
          if (badgeIds.length > 0) {
            queryParams.push(badgeIds);
          }
          
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
        ORDER BY l.listing_id
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
            const placeholders = firstBatchIds.map((_, i) => `$${i + 1}`).join(',');
            
            let detailsSQL = `
              SELECT 
                l.listing_id as id,
                l.name,
                l.bedrooms,
                l.bathrooms, 
                l.price_usd as "priceUSD",
                COALESCE(l."rank", 90 + random()*10) as listing_score,
                l.location_text as location,
                l.city, 
                l.country, 
                COALESCE(l.hero_image_url, '') as "heroImage",
                COALESCE(l.images_json, '[]'::jsonb) as images_json,  
                l.updated_at
              FROM listings l
              WHERE l.listing_id IN (${placeholders})
            `;
            
            if (badgeIds.length > 0) {
              detailsSQL += ` AND EXISTS (
                SELECT 1 FROM property_badges pb 
                WHERE pb.property_id = l.listing_id 
                AND pb.badge_id = ANY($${firstBatchIds.length + 1}::bigint[])
              )`;
            }
            
            detailsSQL += ` ORDER BY array_position(ARRAY[${placeholders}], l.listing_id)`;
            
            const queryParams = [...firstBatchIds];
            if (badgeIds.length > 0) {
              queryParams.push(badgeIds);
            }
            
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

    // ✅ SOLUCIÓN DEFINITIVA: Query principal completamente segura
    const standardParams = [...params];
    standardParams.push(lim);
    standardParams.push(off);

    // Query principal - SIN RANK en SELECT
    const sql = `
      SELECT 
        l.listing_id as id,
        l.name,
        l.bedrooms,
        l.bathrooms, 
        l.price_usd as "priceUSD",
        COALESCE(l."rank", 90 + random()*10) as listing_score,
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

    // ✅ SOLUCIÓN: Count query completamente separada y segura
    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings l
      ${whereSQL};
    `;

    console.log('🔍 Executing main query with order:', orderSQL);
    console.log('🔍 Count SQL:', countSQL);

    // ✅ SOLUCIÓN: Ejecutar las queries por separado para debugging
    let rowsResult, countResult;
    
    try {
      console.log('📊 Executing main query...');
      rowsResult = await pool.query(sql, standardParams);
      console.log('📊 Main query successful, rows:', rowsResult.rows.length);
    } catch (err) {
      console.error('❌ Main query failed:', err.message);
      throw err;
    }
    
    try {
      console.log('📊 Executing count query...');
      countResult = await pool.query(countSQL, params);
      console.log('📊 Count query successful, total:', countResult.rows[0].total);
    } catch (err) {
      console.error('❌ Count query failed:', err.message);
      throw err;
    }

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
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      position: err.position,
      query: err.query // Esto mostrará qué query está fallando
    });
    res.status(500).json({ message: 'Error fetching listings' });
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

// ✅ SOLUCIÓN: Función normalizeResults actualizada
function normalizeResults(results) {
  const PLACEHOLDER = 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80&auto=format&fit=crop';
  
  return results.map((item) => {
    const images = Array.isArray(item.images_json) ? item.images_json : [];
    const first = images[0];
    
    // ✅ Usar listing_score en lugar de calculated_rank
    const { listing_score, ...rest } = item;
    
    return {
      ...rest,
      id: item.id || `temp-${Math.random().toString(36).slice(2)}`,
      rank: listing_score, // Mapear para frontend
      images_json: images,
      heroImage: (typeof first === 'string' && first) || item.heroImage || PLACEHOLDER,
    };
  });
}

export default r;