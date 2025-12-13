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
      availabilityCursor = '0',
      destination = '',
      guests = '',
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
      destination: destination || '',
      guests: guests || '',
      limit,
      offset,
      sort
    };
    const cacheKey = `public:listings:${JSON.stringify(normalizedQuery)}`;

    // 🔥 Mapeo dinámico de badges a campos VillaNet (se generará automáticamente)
    // Primero obtengamos los campos booleanos existentes de VillaNet
    const { rows: villaNetBooleanFields } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns 
      WHERE table_name = 'listings' 
        AND table_schema = 'public'
        AND column_name LIKE 'villanet_%'
        AND data_type = 'boolean'
      ORDER BY column_name;
    `);

    // 🔥 Crear mapeo dinámico de slugs a campos
    const VILLANET_BADGE_FIELD_MAP = {};
    villaNetBooleanFields.forEach(field => {
      const fieldName = field.column_name;
      // Convertir villanet_chef_included -> chef-included
      const slug = fieldName.replace('villanet_', '').replace(/_/g, '-');
      VILLANET_BADGE_FIELD_MAP[slug] = fieldName;
    });

    console.log('[Public API] Dynamic VillaNet badge map:', VILLANET_BADGE_FIELD_MAP);

    // Construcción de filtros SQL
    const clauses = [];
    const params = [];

    // 🔥 BÚSQUEDA UNIFICADA: destination + q buscan en los mismos campos
    let searchTerm = '';
    
    // Prioridad: destination primero, luego q
    if (destination?.toString().trim()) {
      searchTerm = destination.toString().trim();
    } else if (q?.toString().trim()) {
      searchTerm = q.toString().trim();
    }
    
    // Si hay término de búsqueda (de cualquiera de las dos fuentes)
    if (searchTerm) {
      const searchLower = `%${searchTerm.toLowerCase()}%`;
      params.push(searchLower);
      const idx = params.length;
      
      // 🔥 BUSCAR EN TODOS LOS CAMPOS RELEVANTES
      clauses.push(`(
        LOWER(l.name) ILIKE $${idx} OR 
        LOWER(l.villanet_destination_tag) ILIKE $${idx} OR 
        LOWER(l.villanet_city) ILIKE $${idx} OR
        LOWER(l.city) ILIKE $${idx} OR
        LOWER(l.country) ILIKE $${idx} OR
        LOWER(l.location_text) ILIKE $${idx} OR
        LOWER(l.description) ILIKE $${idx}
      )`);
    }

    // 🔥 FILTRO POR BADGES VILLANET (CAMPOS BOOLEANOS)
    const badgeSlugs = badges.split(',').filter(Boolean);
    
    if (badgeSlugs.length > 0) {
      console.log('[Public API] Filtering by VillaNet badges:', badgeSlugs);
      
      // Verificar que todos los slugs sean válidos
      const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
      
      if (validSlugs.length > 0) {
        // Agregar condición para cada badge VillaNet seleccionado
        validSlugs.forEach(slug => {
          const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
          clauses.push(`l.${fieldName} = true`);
        });
        
        console.log('[Public API] Applied VillaNet badge filters:', {
          requested: badgeSlugs,
          valid: validSlugs,
          fields: validSlugs.map(slug => VILLANET_BADGE_FIELD_MAP[slug])
        });
      } else {
        console.log('[Public API] No valid VillaNet badges found for:', badgeSlugs);
      }
    }

    // Bedrooms
    const bedroomsList = bedrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bedroomsList.length) {
      // si viene "5+" -> mínimo 5
      if (bedroomsList.includes('5+')) {
        clauses.push(`l.bedrooms >= 5`);
      } else {
        // tomá el mínimo (por si viniera más de uno)
        const mins = bedroomsList.filter(v => /^\d+$/.test(v)).map(Number);
        if (mins.length) {
          const minBedrooms = Math.min(...mins);
          params.push(minBedrooms);
          clauses.push(`l.bedrooms >= $${params.length}`);
        }
      }
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

    if (guests) {
      const guestsInt = parseInt(String(guests), 10);
      if (!Number.isNaN(guestsInt) && guestsInt > 0) {
        params.push(guestsInt);
        const idx = params.length;
    
        // 1) usar max_guests si existe
        // 2) fallback: bedrooms*2 si max_guests es null
        clauses.push(`COALESCE(l.max_guests, (l.bedrooms * 2)) >= $${idx}`);
      }
    }

    // Filtros base VillaNet
    clauses.push(`l.is_listed = true`);
    clauses.push(`l.villanet_enabled = true`);
    clauses.push(`(l.images_json IS NOT NULL AND l.images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // 🔥 ORDENAMIENTO CORREGIDO - SOLO villanet_rank real
    let orderSQL = `ORDER BY l.updated_at DESC`;

    if (sort === 'price_low') {
      orderSQL = `ORDER BY l.price_usd ASC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'price_high') {
      orderSQL = `ORDER BY l.price_usd DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'bedrooms') {
      orderSQL = `ORDER BY l.bedrooms DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'rank') {
      // 🔥 Usa EXACTAMENTE villanet_rank de la BD, sin modificaciones
      orderSQL = `ORDER BY l.villanet_rank DESC NULLS LAST, l.updated_at DESC`;
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

              -- 🔥 Rank REAL de la BD - SIN FALLBACK
              l.villanet_rank as rank,

              -- Ubicación "bonita" VillaNet primero
              COALESCE(l.villanet_destination_tag, l.villanet_city, l.location_text) as location,

              -- Campos VillaNet extra
              l.villanet_destination_tag as "villaNetDestinationTag",
              l.villanet_city as "villaNetCity",
              l.villanet_property_manager_name as "villaNetPropertyManagerName",
              l.villanet_commission_rate as "villaNetCommissionRate",

              -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
              l.villanet_gated_community as "villanetGatedCommunity",
              l.villanet_golf_villa as "villanetGolfVilla",
              l.villanet_resort_villa as "villanetResortVilla",
              l.villanet_resort_collection_name as "villanetResortCollectionName",
              l.villanet_chef_included as "villanetChefIncluded",
              l.villanet_true_beach_front as "villanetTrueBeachFront",
              l.villanet_cook_included as "villanetCookIncluded",
              l.villanet_waiter_butler_included as "villanetWaiterButlerIncluded",
              l.villanet_ocean_front as "villanetOceanFront",
              l.villanet_ocean_view as "villanetOceanView",
              l.villanet_walk_to_beach as "villanetWalkToBeach",
              l.villanet_accessible as "villanetAccessible",
              l.villanet_private_gym as "villanetPrivateGym",
              l.villanet_private_cinema as "villanetPrivateCinema",
              l.villanet_pickleball as "villanetPickleball",
              l.villanet_tennis as "villanetTennis",
              l.villanet_golf_cart_included as "villanetGolfCartIncluded",
              l.villanet_heated_pool as "villanetHeatedPool",

              l.city, 
              l.country, 
              COALESCE(l.hero_image_url, '') as "heroImage",
              COALESCE(l.images_json, '[]'::jsonb) as images_json,  
              l.updated_at
            FROM listings l
            WHERE l.listing_id IN (${placeholders})
          `;
          
          // Agregar filtros VillaNet si hay badges seleccionados
          if (badgeSlugs.length > 0) {
            const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
            validSlugs.forEach(slug => {
              const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
              detailsSQL += ` AND l.${fieldName} = true`;
            });
          }
          
          detailsSQL += ` ORDER BY array_position(ARRAY[${placeholders}], l.listing_id)`;
          
          const queryParams = [...batchIds];
          
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

                -- 🔥 Rank REAL de la BD - SIN FALLBACK
                l.villanet_rank as rank,

                -- Ubicación "bonita" VillaNet primero
                COALESCE(l.villanet_destination_tag, l.villanet_city, l.location_text) as location,

                -- Campos VillaNet extra
                l.villanet_destination_tag as "villaNetDestinationTag",
                l.villanet_city as "villaNetCity",
                l.villanet_property_manager_name as "villaNetPropertyManagerName",
                l.villanet_commission_rate as "villaNetCommissionRate",

                -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
                l.villanet_gated_community as "villanetGatedCommunity",
                l.villanet_golf_villa as "villanetGolfVilla",
                l.villanet_resort_villa as "villanetResortVilla",
                l.villanet_resort_collection_name as "villanetResortCollectionName",
                l.villanet_chef_included as "villanetChefIncluded",
                l.villanet_true_beach_front as "villanetTrueBeachFront",
                l.villanet_cook_included as "villanetCookIncluded",
                l.villanet_waiter_butler_included as "villanetWaiterButlerIncluded",
                l.villanet_ocean_front as "villanetOceanFront",
                l.villanet_ocean_view as "villanetOceanView",
                l.villanet_walk_to_beach as "villanetWalkToBeach",
                l.villanet_accessible as "villanetAccessible",
                l.villanet_private_gym as "villanetPrivateGym",
                l.villanet_private_cinema as "villanetPrivateCinema",
                l.villanet_pickleball as "villanetPickleball",
                l.villanet_tennis as "villanetTennis",
                l.villanet_golf_cart_included as "villanetGolfCartIncluded",
                l.villanet_heated_pool as "villanetHeatedPool",

                l.city, 
                l.country, 
                COALESCE(l.hero_image_url, '') as "heroImage",
                COALESCE(l.images_json, '[]'::jsonb) as images_json,  
                l.updated_at
              FROM listings l
              WHERE l.listing_id IN (${placeholders})
            `;
            
            // Agregar filtros VillaNet si hay badges seleccionados
            if (badgeSlugs.length > 0) {
              const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
              validSlugs.forEach(slug => {
                const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
                detailsSQL += ` AND l.${fieldName} = true`;
              });
            }
            
            detailsSQL += ` ORDER BY array_position(ARRAY[${placeholders}], l.listing_id)`;
            
            const queryParams = [...firstBatchIds];
            
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

    // Query principal
    const standardParams = [...params];
    standardParams.push(lim);
    standardParams.push(off);

    // 🔥 QUERY PRINCIPAL ACTUALIZADA - Incluye todos los campos VillaNet
    const sql = `
      SELECT 
        l.listing_id as id,
        l.name,
        l.bedrooms,
        l.bathrooms, 
        l.price_usd as "priceUSD",

        -- 🔥 Rank REAL de la BD - SIN FALLBACK, SIN RANDOM, SIN MULTIPLICAR
        l.villanet_rank as rank,

        -- Ubicación "bonita" VillaNet primero
        COALESCE(l.villanet_destination_tag, l.villanet_city, l.location_text) as location,

        -- Campos VillaNet extra
        l.villanet_destination_tag as "villaNetDestinationTag",
        l.villanet_city as "villaNetCity",
        l.villanet_property_manager_name as "villaNetPropertyManagerName",
        l.villanet_commission_rate as "villaNetCommissionRate",

        -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
        l.villanet_gated_community as "villanetGatedCommunity",
        l.villanet_golf_villa as "villanetGolfVilla",
        l.villanet_resort_villa as "villanetResortVilla",
        l.villanet_resort_collection_name as "villanetResortCollectionName",
        l.villanet_chef_included as "villanetChefIncluded",
        l.villanet_true_beach_front as "villanetTrueBeachFront",
        l.villanet_cook_included as "villanetCookIncluded",
        l.villanet_waiter_butler_included as "villanetWaiterButlerIncluded",
        l.villanet_ocean_front as "villanetOceanFront",
        l.villanet_ocean_view as "villanetOceanView",
        l.villanet_walk_to_beach as "villanetWalkToBeach",
        l.villanet_accessible as "villanetAccessible",
        l.villanet_private_gym as "villanetPrivateGym",
        l.villanet_private_cinema as "villanetPrivateCinema",
        l.villanet_pickleball as "villanetPickleball",
        l.villanet_tennis as "villanetTennis",
        l.villanet_golf_cart_included as "villanetGolfCartIncluded",
        l.villanet_heated_pool as "villanetHeatedPool",

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

    // Count query
    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings l
      ${whereSQL};
    `;

    // Ejecutar queries
    const [rowsResult, countResult] = await Promise.all([
      pool.query(sql, standardParams),
      pool.query(countSQL, params)
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
        max_guests,
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

// 🔥 FUNCIÓN normalizeResults ACTUALIZADA - Incluye los nuevos campos
function normalizeResults(results) {
  const PLACEHOLDER = 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80&auto=format&fit=crop';
  
  return results.map((item) => {
    const images = Array.isArray(item.images_json) ? item.images_json : [];
    const first = images[0];

    // 🔥 NORMALIZACIÓN CORRECTA DEL RANK:
    const rank = (item.rank !== null && item.rank !== undefined)
      ? Number(item.rank)
      : null;
    
    // 🔥 Normalizar booleanos de VillaNet (asegurar que sean booleanos)
    const normalizeBoolean = (value) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value === '1';
      }
      return Boolean(value);
    };
    
    return {
      ...item,
      rank: rank,
      
      // 🔥 Asegurar que los campos booleanos sean realmente booleanos
      villanetChefIncluded: normalizeBoolean(item.villanetChefIncluded),
      villanetHeatedPool: normalizeBoolean(item.villanetHeatedPool),
      villanetOceanView: normalizeBoolean(item.villanetOceanView),
      villanetTrueBeachFront: normalizeBoolean(item.villanetTrueBeachFront),
      villanetGolfCartIncluded: normalizeBoolean(item.villanetGolfCartIncluded),
      villanetTennis: normalizeBoolean(item.villanetTennis),
      villanetPickleball: normalizeBoolean(item.villanetPickleball),
      villanetPrivateGym: normalizeBoolean(item.villanetPrivateGym),
      villanetPrivateCinema: normalizeBoolean(item.villanetPrivateCinema),
      villanetCookIncluded: normalizeBoolean(item.villanetCookIncluded),
      villanetWaiterButlerIncluded: normalizeBoolean(item.villanetWaiterButlerIncluded),
      villanetOceanFront: normalizeBoolean(item.villanetOceanFront),
      villanetWalkToBeach: normalizeBoolean(item.villanetWalkToBeach),
      villanetAccessible: normalizeBoolean(item.villanetAccessible),
      villanetGatedCommunity: normalizeBoolean(item.villanetGatedCommunity),
      villanetGolfVilla: normalizeBoolean(item.villanetGolfVilla),
      villanetResortVilla: normalizeBoolean(item.villanetResortVilla),

      id: item.id || `temp-${Math.random().toString(36).slice(2)}`,
      images_json: images,
      heroImage: (typeof first === 'string' && first) || item.heroImage || PLACEHOLDER,
    };
  });
}

export default r;