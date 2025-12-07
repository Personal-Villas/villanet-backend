import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import { getAvailabilityFor } from '../services/availability.service.js';

const r = Router();

const MAX_AVAILABILITY_SESSION_SIZE = 1000;
const AVAILABILITY_SESSION_TTL = 300000;

/************************************************************
 * GET /listings (PRIVADO – admin/TA/PMC)
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
      limit = '24',
      offset = '0',
      sort = 'rank',
      availabilitySession = '',
      availabilityCursor = '0',
      destination = '' // 🔥 NUEVO: Filtro por destination
    } = req.query;

    const lim = Math.min(Math.max(parseInt(limit) || 24, 1), 100);
    const off = Math.max(parseInt(offset) || 0, 0);
    const cursor = parseInt(availabilityCursor) || 0;
    const hasAvailabilityFilter = !!(checkIn && checkOut);

    // 🔥 Detectar campos booleanos VillaNet dinámicamente
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
      const slug = fieldName.replace('villanet_', '').replace(/_/g, '-');
      VILLANET_BADGE_FIELD_MAP[slug] = fieldName;
    });

    console.log('[Private API] Dynamic VillaNet badge map:', VILLANET_BADGE_FIELD_MAP);

    /***********************
     * SQL FILTERS
     ***********************/
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
      
      // 🔥 BUSCAR EN TODOS LOS CAMPOS RELEVANTES (CONSISTENTE CON ENDPOINT PÚBLICO)
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
      console.log('[Private API] Filtering by VillaNet badges:', badgeSlugs);
      
      // Verificar que todos los slugs sean válidos
      const validSlugs = badgeSlugs.filter(slug => VILLANET_BADGE_FIELD_MAP[slug]);
      
      if (validSlugs.length > 0) {
        // Agregar condición para cada badge VillaNet seleccionado
        validSlugs.forEach(slug => {
          const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
          clauses.push(`l.${fieldName} = true`);
        });
        
        console.log('[Private API] Applied VillaNet badge filters:', {
          requested: badgeSlugs,
          valid: validSlugs,
          fields: validSlugs.map(slug => VILLANET_BADGE_FIELD_MAP[slug])
        });
      } else {
        console.log('[Private API] No valid VillaNet badges found for:', badgeSlugs);
      }
    }

    // Bedrooms
    const bedroomsList = bedrooms.split(',').filter(Boolean);
    if (bedroomsList.length) {
      const nums = bedroomsList.filter(v => /^\d+$/.test(v)).map(Number);
      const has5 = bedroomsList.includes('5+');
      const has6 = bedroomsList.includes('6+');

      const ORs = [];
      if (nums.length) {
        params.push(nums);
        ORs.push(`l.bedrooms = ANY($${params.length}::int[])`);
      }
      if (has6) ORs.push(`l.bedrooms >= 6`);
      else if (has5) ORs.push(`l.bedrooms >= 5`);

      clauses.push(`(${ORs.join(' OR ')})`);
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
     * NO-DATES MODE
     ***********************/
    if (!hasAvailabilityFilter) {
      const sql = `
        SELECT 
          l.listing_id AS id,
          l.name,
          l.bedrooms,
          l.bathrooms,
          l.price_usd AS "priceUSD",

          -- REAL RANK
          l.villanet_rank AS rank,

          -- REAL VILLANET LOCATION
          COALESCE(l.villanet_destination_tag, l.villanet_city, l.city) AS location,

          l.villanet_destination_tag AS "villaNetDestinationTag",
          l.villanet_city AS "villaNetCity",
          l.villanet_property_manager_name AS "villaNetPropertyManagerName",
          l.villanet_commission_rate AS "villaNetCommissionRate",

          -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
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

      const rows = await pool.query(sql, [...params, lim, off]);
      const count = await pool.query(countSQL, params);

      return res.json({
        results: normalizeResults(rows.rows),
        total: count.rows[0].total,
        limit: lim,
        offset: off,
        hasMore: off + lim < count.rows[0].total
      });
    }

    /***********************
     * AVAILABILITY MODE
     ***********************/
    let candidateIds = [];

    // First request (create session)
    if (!availabilitySession) {
      const idsSQL = `
        SELECT l.listing_id AS id
        FROM listings l
        ${whereSQL}
        LIMIT ${MAX_AVAILABILITY_SESSION_SIZE};
      `;
      const idsRes = await pool.query(idsSQL, params);
      candidateIds = idsRes.rows.map(r => r.id);

      const availability = await getAvailabilityFor(candidateIds, checkIn, checkOut);

      const availableIds = availability
        .filter(a => a.available)
        .map(a => a.listing_id);

      const sessionId = `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      cache.set(
        `availability:${sessionId}`,
        { availableIds, checkIn, checkOut },
        AVAILABILITY_SESSION_TTL
      );

      const batchIds = availableIds.slice(0, lim);
      const detailRows = await fetchDetails(batchIds, orderSQL, badgeSlugs, VILLANET_BADGE_FIELD_MAP);

      return res.json({
        results: normalizeResults(detailRows),
        total: availableIds.length,
        hasMore: availableIds.length > lim,
        availabilityApplied: true,
        availabilitySession: sessionId,
        availabilityCursor: lim
      });
    }

    // Subsequent pages
    const session = cache.get(`availability:${availabilitySession}`);
    if (!session) {
      return res.status(400).json({ message: 'Availability session expired' });
    }

    const { availableIds } = session;

    const batchIds = availableIds.slice(cursor, cursor + lim);
    const detailRows = await fetchDetails(batchIds, orderSQL, badgeSlugs, VILLANET_BADGE_FIELD_MAP);

    return res.json({
      results: normalizeResults(detailRows),
      total: availableIds.length,
      hasMore: cursor + lim < availableIds.length,
      availabilityApplied: true,
      availabilitySession,
      availabilityCursor: cursor + lim
    });

  } catch (err) {
    console.error('❌ Listings error:', err);
    res.status(500).json({ message: 'Server error fetching listings' });
  }
});

/************************************************************
 * GET /listings/:id (PRIVADO – admin/TA/PMC, con TODOS LOS CAMPOS)
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
        price_usd,

        -- REAL LOCATION
        COALESCE(villanet_destination_tag, villanet_city, city) AS location,

        description,
        amenities_json AS amenities,
        images_json,
        hero_image_url,

        -- FULL VILLANET DATA
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

        -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
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

      -- 🔥 NUEVOS CAMPOS BOOLEANOS DE VILLANET
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
  
  // Agregar filtros VillaNet si hay badges seleccionados
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
      ...r,
      rank: r.rank !== null ? Number(r.rank) : null,
      images_json: Array.isArray(r.images_json) ? r.images_json : [],
      heroImage:
        (Array.isArray(r.images_json) && r.images_json[0]) ||
        r.heroImage ||
        PLACEHOLDER,
      
      // 🔥 Asegurar que los campos booleanos sean realmente booleanos
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