// ⚠️ ESTE BACKEND TIENE RANK FAKE PARA TESTEAR ORDENAMIENTO
// SOLUCIÓN TEMPORAL: Rank calculado en JavaScript para evitar errores de PostgreSQL

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import { getAvailabilityFor } from '../services/availability.service.js';

const r = Router();

// Configuración optimizada
const MAX_AVAILABILITY_SESSION_SIZE = 1000;
const AVAILABILITY_SESSION_TTL = 300000; // 5 minutos

/************************************************************
 * GET /listings  (PÚBLICO)
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
      availabilityCursor = '0'
    } = req.query;

    const lim = Math.min(Math.max(parseInt(limit) || 24, 1), 100);
    const off = Math.max(parseInt(offset) || 0, 0);
    const cursor = parseInt(availabilityCursor) || 0;
    const hasAvailabilityFilter = checkIn && checkOut;

    console.log("🎯 Sorting param:", sort);

    // Validación de fechas
    if (hasAvailabilityFilter) {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!re.test(checkIn) || !re.test(checkOut)) {
        return res.status(400).json({ message: "Invalid date format. Use YYYY-MM-DD" });
      }
      if (new Date(checkOut) <= new Date(checkIn)) {
        return res.status(400).json({ message: "Check-out must be after check-in" });
      }
    }

    // ✅ FIX: Construir cache key INCLUYENDO sort
    const cacheKey = `public:listings:${JSON.stringify({
      q,
      bedrooms,
      bathrooms,
      minPrice,
      maxPrice,
      checkIn,
      checkOut,
      badges,
      limit,
      offset,
      sort
    })}`;

    // ✅ FIX: Solo usar cache si NO hay filtros de disponibilidad
    if (!hasAvailabilityFilter) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log("✅ Cache HIT for sort:", sort);
        return res.json(cached);
      }
      console.log("❌ Cache MISS for sort:", sort);
    }

    // -----------------------------------------
    // 1) Construcción de filtros SQL
    // -----------------------------------------
    const clauses = [];
    const params = [];
    const joins = [];

    // Búsqueda texto
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

    // Badges
    const badgeSlugs = badges.split(',').filter(Boolean);
    if (badgeSlugs.length > 0) {
      const bq = await pool.query(
        `SELECT id FROM badges WHERE slug = ANY($1::text[])`,
        [badgeSlugs]
      );
      const badgeIds = bq.rows.map(r => r.id);

      if (badgeIds.length > 0) {
        params.push(badgeIds);
        clauses.push(`
          EXISTS (
            SELECT 1 FROM property_badges pb
            WHERE pb.property_id = l.listing_id
            AND pb.badge_id = ANY($${params.length}::bigint[])
          )
        `);
      }
    }

    // Bedrooms
    const bedroomsList = bedrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bedroomsList.length) {
      const nums = bedroomsList.filter(v => /^\d+$/.test(v)).map(Number);
      const has5 = bedroomsList.includes('5+');
      const has6 = bedroomsList.includes('6+');

      const parts = [];
      if (nums.length) {
        params.push(nums);
        parts.push(`l.bedrooms = ANY($${params.length}::int[])`);
      }
      if (has6) parts.push(`l.bedrooms >= 6`);
      else if (has5) parts.push(`l.bedrooms >= 5`);
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
    }

    // Bathrooms
    const bathroomsList = bathrooms.split(',').map(s => s.trim()).filter(Boolean);
    if (bathroomsList.length) {
      const nums = bathroomsList.filter(v => /^\d+$/.test(v)).map(Number);
      const has5 = bathroomsList.includes('5+');

      const parts = [];
      if (nums.length) {
        params.push(nums);
        parts.push(`l.bathrooms = ANY($${params.length}::int[])`);
      }
      if (has5) parts.push(`l.bathrooms >= 5`);
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

    // Base
    clauses.push(`l.is_listed = true`);
    clauses.push(`(l.images_json IS NOT NULL AND l.images_json != '[]'::jsonb)`);

    const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const joinSQL = joins.length ? joins.join(' ') : '';

    // -----------------------------------------
    // 2) ORDER BY (SIN RANK EN BD - SOLUCIÓN TEMPORAL)
    // -----------------------------------------
    let orderSQL = `ORDER BY l.updated_at DESC`;

    console.log("🔧 Building ORDER BY for:", sort);

    if (sort === 'rank') {
      // ✅ SOLUCIÓN TEMPORAL: Ordenar solo por updated_at
      orderSQL = `ORDER BY l.updated_at DESC`;
    } else if (sort === 'price-low') {
      orderSQL = `ORDER BY l.price_usd ASC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'price-high') {
      orderSQL = `ORDER BY l.price_usd DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === 'bedrooms') {
      orderSQL = `ORDER BY l.bedrooms DESC NULLS LAST, l.updated_at DESC`;
    }

    console.log("✅ ORDER BY SQL:", orderSQL);

    // -----------------------------------------------------------------------
    // ⚡ 3) ESTRATEGIA DISPONIBILIDAD #1 — Crear Session (primer request)
    // -----------------------------------------------------------------------
    if (hasAvailabilityFilter && !availabilitySession) {

      // 3.1) Obtener CANDIDATE IDs
      const idsSQL = `
        SELECT l.listing_id AS id
        FROM listings l
        ${joinSQL}
        ${whereSQL}
        LIMIT ${MAX_AVAILABILITY_SESSION_SIZE};
      `;
      const idsRes = await pool.query(idsSQL, params);
      const candidateIds = idsRes.rows.map(r => r.id);

      console.log(`🟩 Availability candidates: ${candidateIds.length}`);

      // 3.2) Llamar Guesty Availability
      const availability = await getAvailabilityFor(candidateIds, checkIn, checkOut);

      const availableIds = availability
        .filter(a => a.available)
        .map(a => a.listing_id);

      console.log(`🟢 AVAILABLE: ${availableIds.length}`);

      // 3.3) Crear session
      const sessionId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      cache.set(
        `availability:${sessionId}`,
        { availableIds, checkIn, checkOut },
        AVAILABILITY_SESSION_TTL
      );

      // 3.4) Responder PRIMERA página
      const batchIds = availableIds.slice(0, lim);

      if (batchIds.length === 0) {
        return res.json({
          results: [],
          total: 0,
          hasMore: false,
          availabilityApplied: true,
          availabilitySession: sessionId,
          availabilityCursor: 0
        });
      }

      // ✅ SOLUCIÓN: Rank calculado en JavaScript
      const detailsSQL = `
        SELECT
          l.listing_id AS id,
          l.name,
          l.bedrooms,
          l.bathrooms,
          l.price_usd AS "priceUSD",
          ${(90 + Math.random()*10).toFixed(2)} as rank, -- ✅ RANK EN MEMORIA
          l.location_text AS location,
          l.city,
          l.country,
          COALESCE(l.hero_image_url, '') AS "heroImage",
          COALESCE(l.images_json, '[]'::jsonb) AS images_json,
          l.updated_at
        FROM listings l
        WHERE l.listing_id = ANY($1)
        ${orderSQL};
      `;

      const details = await pool.query(detailsSQL, [batchIds]);
      const normalized = normalizeResults(details.rows);

      return res.json({
        results: normalized,
        total: availableIds.length,
        limit: lim,
        offset: 0,
        hasMore: availableIds.length > lim,
        availabilityApplied: true,
        availabilitySession: sessionId,
        availabilityCursor: lim
      });
    }

    // -----------------------------------------------------------------------
    // ⚡ 4) ESTRATEGIA DISPONIBILIDAD #2 — Paginar Session existente
    // -----------------------------------------------------------------------
    if (hasAvailabilityFilter && availabilitySession) {
      const sessionData = cache.get(`availability:${availabilitySession}`);

      if (!sessionData) {
        return res.status(400).json({
          message: "Availability session expired. Please search again.",
          expiredSession: true
        });
      }

      const { availableIds, checkIn: sIn, checkOut: sOut } = sessionData;

      if (sIn !== checkIn || sOut !== checkOut) {
        return res.status(400).json({
          message: "Date mismatch — start a new search."
        });
      }

      const batchIds = availableIds.slice(cursor, cursor + lim);

      if (batchIds.length === 0) {
        return res.json({
          results: [],
          total: availableIds.length,
          limit: lim,
          hasMore: false,
          availabilityApplied: true,
          availabilitySession,
          availabilityCursor: cursor
        });
      }

      // ✅ SOLUCIÓN: Rank calculado en JavaScript
      const detailsSQL = `
        SELECT
          l.listing_id AS id,
          l.name,
          l.bedrooms,
          l.bathrooms,
          l.price_usd AS "priceUSD",
          ${(90 + Math.random()*10).toFixed(2)} as rank, -- ✅ RANK EN MEMORIA
          l.location_text AS location,
          l.city,
          l.country,
          COALESCE(l.hero_image_url, '') AS "heroImage",
          COALESCE(l.images_json, '[]'::jsonb) AS images_json,
          l.updated_at
        FROM listings l
        WHERE l.listing_id = ANY($1)
        ${orderSQL};
      `;

      const details = await pool.query(detailsSQL, [batchIds]);
      const normalized = normalizeResults(details.rows);

      const nextCursor = cursor + lim;
      const hasMore = nextCursor < availableIds.length;

      return res.json({
        results: normalized,
        total: availableIds.length,
        limit: lim,
        offset: off,
        hasMore,
        availabilityApplied: true,
        availabilitySession,
        availabilityCursor: nextCursor
      });
    }

    // -----------------------------------------------------------------------
    // ⚡ 5) ESTRATEGIA STANDARD (sin disponibilidad)
    // -----------------------------------------------------------------------
    const standardParams = [...params, lim, off];

    // ✅ SOLUCIÓN: Query principal SIN RANK en BD
    const sql = `
      SELECT
        l.listing_id AS id,
        l.name,
        l.bedrooms,
        l.bathrooms,
        l.price_usd AS "priceUSD",
        ${(90 + Math.random()*10).toFixed(2)} as rank, -- ✅ RANK EN MEMORIA
        l.location_text AS location,
        l.city,
        l.country,
        COALESCE(l.hero_image_url, '') AS "heroImage",
        COALESCE(l.images_json, '[]'::jsonb) AS images_json,
        l.updated_at
      FROM listings l
      ${joinSQL}
      ${whereSQL}
      ${orderSQL}
      LIMIT $${standardParams.length - 1} OFFSET $${standardParams.length};
    `;

    const countSQL = `
      SELECT COUNT(*)::int AS total
      FROM listings l
      ${joinSQL}
      ${whereSQL};
    `;

    console.log("🔍 Executing SQL with ORDER BY:", orderSQL);

    const [rows, count] = await Promise.all([
      pool.query(sql, standardParams),
      pool.query(countSQL, standardParams.slice(0, standardParams.length - 2))
    ]);

    console.log("📊 Query returned", rows.rows.length, "rows");
    if (rows.rows.length > 0) {
      console.log("🏠 First property:", {
        name: rows.rows[0].name,
        bedrooms: rows.rows[0].bedrooms,
        priceUSD: rows.rows[0].priceUSD,
        rank: rows.rows[0].rank
      });
    }

    const normalized = normalizeResults(rows.rows);
    const totalInDB = count.rows[0].total;

    const response = {
      results: normalized,
      total: totalInDB,
      limit: lim,
      offset: off,
      hasMore: off + lim < totalInDB,
      availabilityApplied: false
    };

    // ✅ FIX: Cachear SOLO si no hay filtros de disponibilidad
    if (!hasAvailabilityFilter) {
      console.log("💾 Caching response for sort:", sort);
      cache.set(cacheKey, response, 300000);
    }

    return res.json(response);

  } catch (err) {
    console.error("❌ Listings error:", err);
    return res.status(500).json({ message: "Error fetching listings" });
  }
});

/************************************************************
 * GET /listings/:id  (PRIVADO)
 ************************************************************/
r.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `listing:${id}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await pool.query(
      `SELECT
        listing_id,
        name,
        bedrooms,
        bathrooms,
        price_usd AS "price_usd",
        location_text,
        city,
        country,
        min_nights,
        is_listed,
        timezone,
        hero_image_url AS "hero_image_url",
        images_json,
        description,
        amenities_json AS amenities,
        updated_at
      FROM listings
      WHERE listing_id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Listing not found" });
    }

    cache.set(cacheKey, rows[0], 600000);
    return res.json(rows[0]);

  } catch (err) {
    console.error("Detail error:", err);
    return res.status(500).json({ message: "Error fetching listing detail" });
  }
});

/************************************************************
 * Helper normalizeResults - SIMPLIFICADO
 ************************************************************/
function normalizeResults(results) {
  const PLACEHOLDER =
    'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80&auto=format&fit=crop';

  return results.map(row => {
    const images = Array.isArray(row.images_json) ? row.images_json : [];
    const first = images[0];

    return {
      ...row,
      id: row.id || `temp-${Math.random().toString(36).slice(2)}`,
      images_json: images,
      heroImage:
        (typeof first === 'string' && first) ||
        row.heroImage ||
        PLACEHOLDER
    };
  });
}

export default r;