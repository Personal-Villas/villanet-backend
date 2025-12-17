import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import { getAvailabilityFor } from '../services/availability.service.js';

const r = Router();

// ✅ Configuración optimizada
const MAX_AVAILABILITY_ITEMS = 200; // Procesar máximo 200 villas para availability
const AVAILABILITY_SESSION_TTL = 600000; // 10 minutos
const AVAILABILITY_TIMEOUT_MS = 45000; // 45 segundos máximo
const AVAILABILITY_BATCH_SIZE = 30; // Procesar en batches de 30
const CONCURRENT_BATCHES = 4; // 4 batches en paralelo

/************************************************************
 * GET /listings (PRIVADO – admin/TA/PMC) - PAGINACIÓN LIMPIA
 ************************************************************/
r.get('/', auth(false), async (req, res) => {
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
      limit = '12',
      page = '1',
      sort = 'rank',
      availabilitySession = '',
      destination = '',
      guests = '', 
    } = req.query;

    const lim = Math.min(Math.max(parseInt(limit) || 12, 1), 100);
    const currentPage = Math.max(parseInt(page) || 1, 1);
    const offset = (currentPage - 1) * lim;
    
    // ✅ SOLO activar availability cuando ambos dates están completos
    const hasAvailabilityFilter = !!(checkIn && checkOut);

    console.log(`📄 [Listings] Page ${currentPage}, limit ${lim}, offset ${offset}, availability: ${hasAvailabilityFilter}`);

    // ✅ Cachear el mapeo de badges
    let VILLANET_BADGE_FIELD_MAP = cache.get('villanet_badge_map');
    
    if (!VILLANET_BADGE_FIELD_MAP) {
      const { rows: villaNetBooleanFields } = await pool.query(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_name = 'listings' 
          AND table_schema = 'public'
          AND column_name LIKE 'villanet_%'
          AND data_type = 'boolean'
        ORDER BY column_name;
      `);

      VILLANET_BADGE_FIELD_MAP = {};
      villaNetBooleanFields.forEach(field => {
        const fieldName = field.column_name;
        const slug = fieldName.replace('villanet_', '').replace(/_/g, '-');
        VILLANET_BADGE_FIELD_MAP[slug] = fieldName;
      });

      cache.set('villanet_badge_map', VILLANET_BADGE_FIELD_MAP, 3600000);
    }

    /***********************
     * SQL FILTERS
     ***********************/
    const clauses = [];
    const params = [];

    // Búsqueda unificada
    let searchTerm = '';
    
    if (destination?.toString().trim()) {
      searchTerm = destination.toString().trim();
    } else if (q?.toString().trim()) {
      searchTerm = q.toString().trim();
    }
    
    if (searchTerm) {
      const searchLower = `%${searchTerm.toLowerCase()}%`;
      params.push(searchLower);
      const idx = params.length;
      
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

    // Filtro por badges
    const badgeSlugs = badges.split(',').filter(Boolean);
    
    if (badgeSlugs.length > 0) {
      const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
      
      if (validSlugs.length > 0) {
        validSlugs.forEach(slug => {
          const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
          clauses.push(`l.${fieldName} = true`);
        });
      }
    }

    // Bedrooms
    const bedroomsList = bedrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bedroomsList.length) {
      if (bedroomsList.includes('5+')) {
        clauses.push(`l.bedrooms >= 5`);
      } else {
        const mins = bedroomsList.filter(v => /^\d+$/.test(v)).map(Number);
        if (mins.length) {
          const minBedrooms = Math.min(...mins);
          params.push(minBedrooms);
          clauses.push(`l.bedrooms >= $${params.length}`);
        }
      }
    }

    // Bathrooms
    const bathroomsList = bathrooms.split(',').filter(Boolean);
    if (bathroomsList.length) {
      const nums = bathroomsList.filter(v => /^\d+$/.test(v)).map(Number);
      const has5 = bathroomsList.includes('5+');

      const ORs = [];
      if (nums.length) {
        params.push(nums);
        ORs.push(`l.bathrooms = ANY($${params.length}::int[])`);
      }
      if (has5) ORs.push(`l.bathrooms >= 5`);

      clauses.push(`(${ORs.join(' OR ')})`);
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

    // Guests
    if (guests) {
      const guestsInt = parseInt(String(guests), 10);
      if (!Number.isNaN(guestsInt) && guestsInt > 0) {
        params.push(guestsInt);
        const idx = params.length;
        clauses.push(`COALESCE(l.max_guests, (l.bedrooms * 2)) >= $${idx}`);
      }
    }

    // Base filters
    clauses.push(`l.is_listed = true`);
    clauses.push(`l.villanet_enabled = true`);
    clauses.push(`(l.images_json IS NOT NULL AND l.images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    /***********************
     * ORDERING
     ***********************/
    let orderSQL = `ORDER BY l.updated_at DESC`;

    if (sort === 'rank') {
      orderSQL = `ORDER BY l.villanet_rank DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'price_low') {
      orderSQL = `ORDER BY l.price_usd ASC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'price_high') {
      orderSQL = `ORDER BY l.price_usd DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'bedrooms') {
      orderSQL = `ORDER BY l.bedrooms DESC NULLS LAST, l.updated_at DESC`;
    }

    /***********************
     * NO-DATES MODE (SIN AVAILABILITY) - PAGINACIÓN SIMPLE
     ***********************/
    if (!hasAvailabilityFilter) {
      const sql = `
        SELECT 
          l.listing_id AS id,
          l.name,
          l.bedrooms,
          l.bathrooms,
          l.price_usd AS "priceUSD",

          l.villanet_rank AS rank,
          COALESCE(l.villanet_destination_tag, l.villanet_city, l.city) AS location,

          l.villanet_destination_tag AS "villaNetDestinationTag",
          l.villanet_city AS "villaNetCity",
          l.villanet_property_manager_name AS "villaNetPropertyManagerName",
          l.villanet_commission_rate AS "villaNetCommissionRate",

          l.villanet_gated_community AS "villanetGatedCommunity",
          l.villanet_golf_villa AS "villanetGolfVilla",
          l.villanet_resort_villa AS "villanetResortVilla",
          l.villanet_resort_collection_name AS "villanetResortCollectionName",
          l.villanet_chef_included AS "villanetChefIncluded",
          l.villanet_true_beach_front AS "villanetTrueBeachFront",
          l.villanet_cook_included AS "villanetCookIncluded",
          l.villanet_waiter_butler_included AS "villanetWaiterButlerIncluded",
          l.villanet_ocean_front AS "villanetOceanFront",
          l.villanet_ocean_view AS "villanetOceanView",
          l.villanet_walk_to_beach AS "villanetWalkToBeach",
          l.villanet_accessible AS "villanetAccessible",
          l.villanet_private_gym AS "villanetPrivateGym",
          l.villanet_private_cinema AS "villanetPrivateCinema",
          l.villanet_pickleball AS "villanetPickleball",
          l.villanet_tennis AS "villanetTennis",
          l.villanet_golf_cart_included AS "villanetGolfCartIncluded",
          l.villanet_heated_pool AS "villanetHeatedPool",

          COALESCE(l.hero_image_url, '') AS "heroImage",
          COALESCE(l.images_json, '[]'::jsonb) AS images_json,
          l.updated_at
        FROM listings l
        ${whereSQL}
        ${orderSQL}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2};
      `;

      const countSQL = `
        SELECT COUNT(*)::int AS total 
        FROM listings l
        ${whereSQL};
      `;

      const [rows, count] = await Promise.all([
        pool.query(sql, [...params, lim, offset]),
        pool.query(countSQL, params)
      ]);

      const total = count.rows[0].total;
      const totalPages = Math.ceil(total / lim);

      console.log(`✅ [No Availability] Page ${currentPage}/${totalPages}, showing ${rows.rows.length} items`);

      return res.json({
        results: normalizeResults(rows.rows),
        total,
        limit: lim,
        offset,
        currentPage,
        totalPages,
        hasMore: currentPage < totalPages
      });
    }

    /***********************
     * AVAILABILITY MODE - PAGINACIÓN CON SESIÓN
     ***********************/
    
    // ✅ PÁGINA 1: Crear sesión nueva
    if (currentPage === 1 || !availabilitySession) {
      console.log(`🔍 [Availability] Creating new session for page 1`);
      
      // Obtener candidatos (limitar a MAX_AVAILABILITY_ITEMS)
      const idsSQL = `
        SELECT l.listing_id AS id
        FROM listings l
        ${whereSQL}
        ${orderSQL}
        LIMIT ${MAX_AVAILABILITY_ITEMS};
      `;
      const idsRes = await pool.query(idsSQL, params);
      const candidateIds = idsRes.rows.map(r => r.id);

      console.log(`📊 [Availability] Processing ${candidateIds.length} candidates (max ${MAX_AVAILABILITY_ITEMS})`);
      
      // Procesar availability en batches concurrentes
      const availableIds = [];
      
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('TIMEOUT')), AVAILABILITY_TIMEOUT_MS);
        });

        const processPromise = (async () => {
          for (let i = 0; i < candidateIds.length; i += AVAILABILITY_BATCH_SIZE * CONCURRENT_BATCHES) {
            const batchPromises = [];
            
            for (let j = 0; j < CONCURRENT_BATCHES; j++) {
              const startIdx = i + (j * AVAILABILITY_BATCH_SIZE);
              if (startIdx >= candidateIds.length) break;
              
              const batchIds = candidateIds.slice(startIdx, startIdx + AVAILABILITY_BATCH_SIZE);
              if (batchIds.length > 0) {
                batchPromises.push(
                  getAvailabilityFor(batchIds, checkIn, checkOut)
                    .then(batchResult => {
                      const batchAvailable = batchResult
                        .filter(a => a.available)
                        .map(a => a.listing_id);
                      availableIds.push(...batchAvailable);
                    })
                    .catch(err => {
                      console.warn(`[Availability] Batch failed:`, err.message);
                    })
                );
              }
            }
            
            if (batchPromises.length > 0) {
              await Promise.all(batchPromises);
            }
            
            // Early stop si tenemos suficientes
            if (availableIds.length >= lim * 5) {
              console.log(`✂️ [Availability] Early stop: ${availableIds.length} available`);
              break;
            }
          }
        })();

        await Promise.race([processPromise, timeoutPromise]);
      } catch (err) {
        if (err.message === 'TIMEOUT') {
          console.warn(`⏱️ [Availability] Timeout after ${AVAILABILITY_TIMEOUT_MS}ms, using ${availableIds.length} results`);
        } else {
          throw err;
        }
      }

      // Crear sesión
      const sessionId = `av_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      cache.set(
        `availability:${sessionId}`,
        { availableIds, checkIn, checkOut, filters: { searchTerm, badgeSlugs, sort } },
        AVAILABILITY_SESSION_TTL
      );

      // Obtener detalles de la página 1
      const pageIds = availableIds.slice(0, lim);
      const detailRows = await fetchDetails(pageIds, orderSQL, badgeSlugs, VILLANET_BADGE_FIELD_MAP);

      const total = availableIds.length;
      const totalPages = Math.ceil(total / lim);

      console.log(`✅ [Availability] Session ${sessionId}: ${total} available, page 1/${totalPages}`);

      return res.json({
        results: normalizeResults(detailRows),
        total,
        limit: lim,
        offset: 0,
        currentPage: 1,
        totalPages,
        hasMore: totalPages > 1,
        availabilityApplied: true,
        availabilitySession: sessionId
      });
    }

    // ✅ PÁGINAS 2+: Usar sesión existente
    console.log(`📖 [Availability] Using existing session for page ${currentPage}`);
    
    const session = cache.get(`availability:${availabilitySession}`);
    if (!session) {
      console.error(`❌ [Availability] Session ${availabilitySession} expired or not found`);
      return res.status(400).json({ 
        message: 'Availability session expired. Please refresh your search.',
        expired: true
      });
    }

    const { availableIds } = session;
    const total = availableIds.length;
    const totalPages = Math.ceil(total / lim);

    // Validar página
    if (currentPage > totalPages) {
      console.warn(`⚠️ [Availability] Requested page ${currentPage} > totalPages ${totalPages}`);
      return res.json({
        results: [],
        total,
        limit: lim,
        offset,
        currentPage,
        totalPages,
        hasMore: false,
        availabilityApplied: true,
        availabilitySession
      });
    }

    // Obtener IDs de la página actual
    const pageIds = availableIds.slice(offset, offset + lim);
    const detailRows = await fetchDetails(pageIds, orderSQL, badgeSlugs, VILLANET_BADGE_FIELD_MAP);

    console.log(`✅ [Availability] Page ${currentPage}/${totalPages}, showing ${detailRows.length} items`);

    return res.json({
      results: normalizeResults(detailRows),
      total,
      limit: lim,
      offset,
      currentPage,
      totalPages,
      hasMore: currentPage < totalPages,
      availabilityApplied: true,
      availabilitySession
    });

  } catch (err) {
    console.error('❌ Listings error:', err);
    
    if (err.message === 'Availability session expired') {
      return res.status(400).json({ 
        message: 'Availability session expired. Please refresh your search.',
        expired: true
      });
    }
    
    if (err.message?.includes('timeout') || err.message?.includes('TIMEOUT')) {
      return res.status(504).json({ 
        message: 'Availability check taking too long. Please try a smaller date range.',
        suggestion: 'Try narrowing your search criteria'
      });
    }
    
    res.status(500).json({ 
      message: 'Server error fetching listings',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/************************************************************
 * GET /listings/:id (PRIVADO – admin/TA/PMC)
 ************************************************************/
r.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT 
        listing_id,
        name,
        bedrooms,
        bathrooms,
        max_guests,
        price_usd,

        COALESCE(villanet_destination_tag, villanet_city, city) AS location,

        description,
        amenities_json AS amenities,
        images_json,
        hero_image_url,

        villanet_rank,
        villanet_commission_rate,
        villanet_destination_tag,
        villanet_city,
        villanet_property_manager_name,
        villanet_partner_reservation_email,
        villanet_property_email,
        villanet_pmc_information,
        villanet_exclusive_units_managed,
        villanet_years_in_business,
        villanet_avg_response_time_hours,
        villanet_calendar_sync_99,
        villanet_credit_card_accepted,
        villanet_insured,
        villanet_bank_transfer_accepted,
        villanet_standardized_housekeeping,
        villanet_staff_gratuity_guideline,

        villanet_gated_community,
        villanet_golf_villa,
        villanet_resort_villa,
        villanet_resort_collection_name,
        villanet_chef_included,
        villanet_true_beach_front,
        villanet_cook_included,
        villanet_waiter_butler_included,
        villanet_ocean_front,
        villanet_ocean_view,
        villanet_walk_to_beach,
        villanet_accessible,
        villanet_private_gym,
        villanet_private_cinema,
        villanet_pickleball,
        villanet_tennis,
        villanet_golf_cart_included,
        villanet_heated_pool,

        updated_at
      FROM listings
      WHERE listing_id = $1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ message: 'Not found' });

    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Detail error:', err);
    res.status(500).json({ message: 'Error fetching detail' });
  }
});

/************************************************************
 * Helpers
 ************************************************************/
async function fetchDetails(ids, orderSQL, badgeSlugs = [], VILLANET_BADGE_FIELD_MAP = {}) {
  if (!ids.length) return [];
  
  let sql = `
    SELECT 
      l.listing_id AS id,
      l.name,
      l.bedrooms,
      l.bathrooms,
      l.price_usd AS "priceUSD",

      l.villanet_rank AS rank,
      COALESCE(l.villanet_destination_tag, l.villanet_city, l.city) AS location,

      l.villanet_destination_tag AS "villaNetDestinationTag",
      l.villanet_city AS "villaNetCity",
      l.villanet_property_manager_name AS "villaNetPropertyManagerName",
      l.villanet_commission_rate AS "villaNetCommissionRate",

      l.villanet_gated_community AS "villanetGatedCommunity",
      l.villanet_golf_villa AS "villanetGolfVilla",
      l.villanet_resort_villa AS "villanetResortVilla",
      l.villanet_resort_collection_name AS "villanetResortCollectionName",
      l.villanet_chef_included AS "villanetChefIncluded",
      l.villanet_true_beach_front AS "villanetTrueBeachFront",
      l.villanet_cook_included AS "villanetCookIncluded",
      l.villanet_waiter_butler_included AS "villanetWaiterButlerIncluded",
      l.villanet_ocean_front AS "villanetOceanFront",
      l.villanet_ocean_view AS "villanetOceanView",
      l.villanet_walk_to_beach AS "villanetWalkToBeach",
      l.villanet_accessible AS "villanetAccessible",
      l.villanet_private_gym AS "villanetPrivateGym",
      l.villanet_private_cinema AS "villanetPrivateCinema",
      l.villanet_pickleball AS "villanetPickleball",
      l.villanet_tennis AS "villanetTennis",
      l.villanet_golf_cart_included AS "villanetGolfCartIncluded",
      l.villanet_heated_pool AS "villanetHeatedPool",

      COALESCE(l.hero_image_url, '') AS "heroImage",
      COALESCE(l.images_json, '[]'::jsonb) AS images_json,
      l.updated_at
    FROM listings l
    WHERE l.listing_id = ANY($1)
  `;
  
  if (badgeSlugs.length > 0) {
    const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
    validSlugs.forEach(slug => {
      const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
      sql += ` AND l.${fieldName} = true`;
    });
  }
  
  sql += ` ${orderSQL};`;
  
  const { rows } = await pool.query(sql, [ids]);
  return rows;
}

function normalizeResults(rows) {
  const PLACEHOLDER = 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200';
  
  return rows.map(r => {
    const normalizeBoolean = (value) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value === '1';
      }
      return Boolean(value);
    };
    
    return {
      ...r,
      rank: r.rank !== null ? Number(r.rank) : null,
      images_json: Array.isArray(r.images_json) ? r.images_json : [],
      heroImage:
        (Array.isArray(r.images_json) && r.images_json[0]) ||
        r.heroImage ||
        PLACEHOLDER,
      
      villanetChefIncluded: normalizeBoolean(r.villanetChefIncluded),
      villanetHeatedPool: normalizeBoolean(r.villanetHeatedPool),
      villanetOceanView: normalizeBoolean(r.villanetOceanView),
      villanetTrueBeachFront: normalizeBoolean(r.villanetTrueBeachFront),
      villanetGolfCartIncluded: normalizeBoolean(r.villanetGolfCartIncluded),
      villanetTennis: normalizeBoolean(r.villanetTennis),
      villanetPickleball: normalizeBoolean(r.villanetPickleball),
      villanetPrivateGym: normalizeBoolean(r.villanetPrivateGym),
      villanetPrivateCinema: normalizeBoolean(r.villanetPrivateCinema),
      villanetCookIncluded: normalizeBoolean(r.villanetCookIncluded),
      villanetWaiterButlerIncluded: normalizeBoolean(r.villanetWaiterButlerIncluded),
      villanetOceanFront: normalizeBoolean(r.villanetOceanFront),
      villanetWalkToBeach: normalizeBoolean(r.villanetWalkToBeach),
      villanetAccessible: normalizeBoolean(r.villanetAccessible),
      villanetGatedCommunity: normalizeBoolean(r.villanetGatedCommunity),
      villanetGolfVilla: normalizeBoolean(r.villanetGolfVilla),
      villanetResortVilla: normalizeBoolean(r.villanetResortVilla),
    };
  });
}

export default r;