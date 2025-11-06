import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import { getAvailabilityFor } from '../services/availability.service.js';

const r = Router();

// Configuración optimizada
const BULK_AVAILABILITY_FETCH_SIZE = 200; // Consulta inicial de disponibilidad
const MAX_AVAILABILITY_SESSION_SIZE = 1000; // Máximo de propiedades en sesión
const AVAILABILITY_SESSION_TTL = 300000; // 5 minutos

/**
 * GET /listings
 * ESTRATEGIA MEJORADA: Cursor de disponibilidad para mejor performance
 */
r.get('/', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
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

    // 🔑 Cache key (agregar badges)
    const normalizedQuery = {
      q: q.trim().toLowerCase(),
      bedrooms: bedrooms.split(',').filter(Boolean).sort().join(','),
      bathrooms: bathrooms.split(',').filter(Boolean).sort().join(','),
      minPrice: minPrice || '',
      maxPrice: maxPrice || '',
      checkIn: checkIn || '',
      checkOut: checkOut || '',
      badges: badges.split(',').filter(Boolean).sort().join(','), // 🆕 Incluir badges en cache
      limit,
      offset,
      sort
    };
    const cacheKey = `listings:${JSON.stringify(normalizedQuery)}`;

    // --- Construcción de filtros SQL ---
    const clauses = [];
    const params = [];
    const joins = []; // 🆕 Array para JOINs

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

    // 🆕 CONVERTIR SLUGS DE BADGES A IDs NUMÉRICOS
    const badgeSlugs = badges.split(',').filter(Boolean);
    let badgeIds = [];
    
    if (badgeSlugs.length > 0) {
      console.log(`🛡️ Looking up badge IDs for slugs:`, badgeSlugs);
      
      // Consultar la base de datos para obtener los IDs numéricos
      const badgeQuery = await pool.query(
        `SELECT id FROM badges WHERE slug = ANY($1::text[])`,
        [badgeSlugs]
      );
      
      badgeIds = badgeQuery.rows.map(row => row.id);
      console.log(`🛡️ Found badge IDs:`, badgeIds);
    }

    // 🆕 Filtro por badges - CORREGIDO: AGREGAR AL CLAUSES
    if (badgeIds.length > 0) {
      params.push(badgeIds);
      
      // ✅ CORRECCIÓN: Agregar la condición al WHERE usando EXISTS
      clauses.push(`EXISTS (
        SELECT 1 FROM property_badges pb 
        WHERE pb.property_id = l.listing_id 
        AND pb.badge_id = ANY($${params.length}::bigint[])
      )`);
      
      console.log(`🛡️ Applied badge filter with ${badgeIds.length} badge IDs`);
    }

    // Bedrooms (código existente)
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

    // Bathrooms (código existente)
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

    // Price (código existente)
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

    // 🆕 Construir WHERE (ya no necesitamos JOINs explícitos para badges)
    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const joinSQL = joins.length ? joins.join(' ') : '';

    // Ordenamiento (código existente)
    let orderSQL = `ORDER BY updated_at DESC`;
    if (sort === 'price_asc') orderSQL = `ORDER BY price_usd ASC NULLS LAST, updated_at DESC`;
    else if (sort === 'price_desc') orderSQL = `ORDER BY price_usd DESC NULLS LAST, updated_at DESC`;

    // 🎯 ESTRATEGIA MEJORADA: CURSOR DE DISPONIBILIDAD
    if (hasAvailabilityFilter && availabilitySession) {
      console.log(`[Availability Session] Continuing session: ${availabilitySession}, cursor: ${cursor}`);
      
      const availableIds = cache.get(availabilitySession);
      
      if (availableIds && Array.isArray(availableIds)) {
        const startIdx = cursor;
        const batchIds = availableIds.slice(startIdx, startIdx + lim);
        
        if (batchIds.length > 0) {
          // 🆕 Usar EXISTS para badges en sesión de disponibilidad
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
          
          // 🆕 Agregar condición de badges si es necesario
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
          
          const response = {
            results: normalized,
            total: availableIds.length,
            limit: lim,
            offset: nextCursor,
            hasMore,
            availabilityApplied: true,
            availabilitySession: hasMore ? availabilitySession : null,
            availabilityCursor: hasMore ? nextCursor : null
          };
          
          console.log(`[Availability Session] Returning ${normalized.length} properties, cursor: ${nextCursor}, hasMore: ${hasMore}`);
          return res.json(response);
        } else {
          // No más propiedades disponibles
          return res.json({
            results: [],
            total: availableIds.length,
            limit: lim,
            offset: cursor,
            hasMore: false,
            availabilityApplied: true,
            availabilitySession: null,
            availabilityCursor: null
          });
        }
      } else {
        // Session expirada
        console.log(`[Availability Session] Expired: ${availabilitySession}`);
        // Continuar con estrategia normal
      }
    }

    // 🎯 ESTRATEGIA MEJORADA: CONSULTA MASIVA INICIAL DE DISPONIBILIDAD
    if (hasAvailabilityFilter && !availabilitySession) {
      console.log(`[Availability Strategy] Initial bulk fetch for ${checkIn} to ${checkOut}`);
      
      // 1. Consultar propiedades candidatas (más de las necesarias)
      const bulkFetchLimit = Math.min(BULK_AVAILABILITY_FETCH_SIZE, MAX_AVAILABILITY_SESSION_SIZE);
      
      const bulkParams = [...params];
      bulkParams.push(bulkFetchLimit);
      bulkParams.push(off);

      // 🆕 Construir SQL
      const bulkSQL = `
        SELECT l.listing_id as id
        FROM listings l
        ${joinSQL}
        ${whereSQL}
        ${orderSQL}
        LIMIT $${bulkParams.length-1} OFFSET $${bulkParams.length};
      `;

      const bulkResult = await pool.query(bulkSQL, bulkParams);
      const candidateIds = bulkResult.rows.map(r => r.id);

      if (candidateIds.length > 0) {
        try {
          console.log(`[Availability Strategy] Checking availability for ${candidateIds.length} candidates`);
          
          // 2. Consultar disponibilidad de TODAS las candidatas
          const availability = await getAvailabilityFor(candidateIds, checkIn, checkOut);
          const availableIds = availability
            .filter(a => a.available === true)
            .map(a => a.listing_id);
          
          console.log(`[Availability Strategy] Found ${availableIds.length}/${candidateIds.length} available properties`);
          
          // 3. Crear session de disponibilidad
          const availabilitySessionKey = `avail_session:${checkIn}:${checkOut}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
          cache.set(availabilitySessionKey, availableIds, AVAILABILITY_SESSION_TTL);
          
          // 4. Devolver primer lote
          const firstBatchIds = availableIds.slice(0, lim);
          
          if (firstBatchIds.length > 0) {
            // 🆕 Usar EXISTS para badges
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
            
            const response = {
              results: normalized,
              total: availableIds.length,
              limit: lim,
              offset: nextCursor,
              hasMore,
              availabilityApplied: true,
              availabilitySession: hasMore ? availabilitySessionKey : null,
              availabilityCursor: hasMore ? nextCursor : null
            };
            
            console.log(`[Availability Strategy] Returning ${normalized.length} properties, session: ${availabilitySessionKey}, hasMore: ${hasMore}`);
            return res.json(response);
          } else {
            // No hay propiedades disponibles en este lote
            return res.json({
              results: [],
              total: availableIds.length,
              limit: lim,
              offset: 0,
              hasMore: false,
              availabilityApplied: true,
              availabilitySession: null,
              availabilityCursor: null
            });
          }
          
        } catch (err) {
          console.error('[Availability Strategy] Bulk check failed:', err);
          // Fallback a estrategia original
          console.log('[Availability Strategy] Falling back to original strategy');
        }
      }
    }

    // 📋 ESTRATEGIA ORIGINAL (sin disponibilidad o fallback)
    console.log(`[Standard Strategy] Fetching ${lim} properties at offset ${off}`);
    
    const standardParams = [...params];
    standardParams.push(lim);
    standardParams.push(off);

    // 🆕 Construir SQL final
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
      ${joinSQL}
      ${whereSQL}
      ${orderSQL}
      LIMIT $${standardParams.length-1} OFFSET $${standardParams.length};
    `;

    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings l
      ${joinSQL}
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

    // Cache solo para consultas sin disponibilidad
    if (!hasAvailabilityFilter) {
      cache.set(cacheKey, response, 300000); // 5 minutos
    }
    
    console.log(`[Standard Strategy] Returning ${normalized.length} properties, hasMore: ${hasMore}`);
    
    res.json(response);
  } catch (err) {
    console.error('Listings DB error:', err);
    
    if (err.message?.includes('429')) {
      return res.status(429).json({ 
        message: 'Too many requests. Please wait a moment and try again.',
        retryAfter: 60
      });
    }
    
    res.status(500).json({ message: err.message || 'Error fetching listings' });
  }
});

/**
 * GET /listings/:id
 */
r.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `listing:${id}`;

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

    cache.set(cacheKey, result, 600000); // 10 min
    res.json(result);
  } catch (err) {
    console.error('Listing detail DB error:', err);
    res.status(500).json({ message: err.message || 'Error fetching listing detail' });
  }
});

/**
 * Helper para normalizar resultados
 */
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