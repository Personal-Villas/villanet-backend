import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { pool } from "../db.js";
import { cache } from "../cache.js";

const r = Router();

// ✅ Configuración OPTIMIZADA IDÉNTICA a ruta pública
const AVAILABILITY_SESSION_TTL = 600000; // 10 minutos
const LAZY_SCAN_CHUNK = 120; // Candidatos por ciclo de escaneo
const AV_BATCH_SIZE = 15; // Batch size reducido
const AV_CONCURRENCY = 2; // Máximo 2 consultas concurrentes

/************************************************************
 * GET /listings (PRIVADO – admin/TA/PMC) - PAGINACIÓN OPTIMIZADA IDÉNTICA
 ************************************************************/
r.get("/", auth(false), async (req, res) => {
  try {
    const {
      q = "",
      bedrooms = "",
      bathrooms = "",
      minPrice = "",
      maxPrice = "",
      checkIn = "",
      checkOut = "",
      badges = "",
      limit = "12",
      page = "1",
      cursor = "0",
      sort = "rank",
      availabilitySession = "",
      destination = "",
      destinations = "", // comma-separated from Quote Wizard multi-select
      guests = "",
    } = req.query;

    const lim = Math.min(Math.max(parseInt(limit) || 12, 1), 100);
    const currentPage = Math.max(parseInt(page) || 1, 1);
    const cursorPos = Math.max(parseInt(cursor) || 0, 0);

    // ✅ SOLO activar availability cuando ambos dates están completos (IDÉNTICO)
    const hasAvailabilityFilter = !!(checkIn && checkOut);

    console.log(
      `📄 [Listings Privado] Page ${currentPage}, limit ${lim}, cursor ${cursorPos}, availability: ${hasAvailabilityFilter}`,
    );

    // ✅ Cachear el mapeo de badges (COMPARTIDO)
    let VILLANET_BADGE_FIELD_MAP = cache.get("villanet_badge_map");

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
      villaNetBooleanFields.forEach((field) => {
        const fieldName = field.column_name;
        const slug = fieldName.replace("villanet_", "").replace(/_/g, "-");
        VILLANET_BADGE_FIELD_MAP[slug] = fieldName;
      });

      cache.set("villanet_badge_map", VILLANET_BADGE_FIELD_MAP, 3600000);
    }

    /***********************
     * SQL FILTERS IDÉNTICOS
     ***********************/
    const clauses = [];
    const params = [];

    // Búsqueda unificada
    let searchTerm = "";

    // 1. FILTRO DE DESTINO — soporta uno o múltiples destinos (OR entre ellos)
    const destinationsList = destinations?.toString().trim()
      ? destinations.toString().split(',').map(d => d.trim()).filter(Boolean)
      : destination?.toString().trim()
        ? [destination.toString().trim()]
        : [];

    if (destinationsList.length > 0) {
      // Establecer searchTerm para compatibilidad con la búsqueda general posterior
      searchTerm = destinationsList[0];

      if (destinationsList.length === 1) {
        // Un solo destino: ILIKE con normalización de puntos/tildes
        const cleanDest = destinationsList[0].replace(/\./g, '').toLowerCase();
        params.push(`%${cleanDest}%`);
        const idx = params.length;
        clauses.push(`(
          unaccent(LOWER(REPLACE(l.villanet_destination_tag, '.', ''))) ILIKE unaccent($${idx}) OR
          unaccent(LOWER(REPLACE(l.villanet_city, '.', ''))) ILIKE unaccent($${idx}) OR
          unaccent(LOWER(REPLACE(l.city, '.', ''))) ILIKE unaccent($${idx}) OR
          unaccent(LOWER(REPLACE(l.country, '.', ''))) ILIKE unaccent($${idx})
        )`);
      } else {
        // Múltiples destinos: un OR por cada destino (cada uno con su ILIKE normalizado)
        const destConditions = destinationsList.map(dest => {
          const cleanDest = dest.replace(/\./g, '').toLowerCase();
          params.push(`%${cleanDest}%`);
          const idx = params.length;
          return `(
            unaccent(LOWER(REPLACE(l.villanet_destination_tag, '.', ''))) ILIKE unaccent($${idx}) OR
            unaccent(LOWER(REPLACE(l.villanet_city, '.', ''))) ILIKE unaccent($${idx}) OR
            unaccent(LOWER(REPLACE(l.city, '.', ''))) ILIKE unaccent($${idx}) OR
            unaccent(LOWER(REPLACE(l.country, '.', ''))) ILIKE unaccent($${idx})
          )`;
        });
        clauses.push(`(${destConditions.join(' OR ')})`);
      }

    } else if (q?.toString().trim()) {
      searchTerm = q.toString().trim();
      // 2. Búsqueda General (Solo si NO hay destino seleccionado)
      // Aquí sí permitimos buscar en descripción y nombre.
      const searchTerm = q.toString().trim();
      params.push(`%${searchTerm.toLowerCase()}%`);
      const idx = params.length;
      
      clauses.push(`(
        unaccent(LOWER(l.name)) ILIKE unaccent($${idx}) OR 
        unaccent(LOWER(l.villanet_destination_tag)) ILIKE unaccent($${idx}) OR 
        unaccent(LOWER(l.villanet_city)) ILIKE unaccent($${idx}) OR
        unaccent(LOWER(l.city)) ILIKE unaccent($${idx}) OR
        unaccent(LOWER(l.country)) ILIKE unaccent($${idx}) OR
        unaccent(LOWER(l.location_text)) ILIKE unaccent($${idx}) OR
        unaccent(LOWER(l.description)) ILIKE unaccent($${idx})
      )`);
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
    const badgeSlugs = badges.split(",").filter(Boolean);

    if (badgeSlugs.length > 0) {
      const validSlugs = badgeSlugs.filter(
        (slug) => VILLANET_BADGE_FIELD_MAP[slug],
      );

      if (validSlugs.length > 0) {
        validSlugs.forEach((slug) => {
          const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
          clauses.push(`l.${fieldName} = true`);
        });
      }
    }

    // Bedrooms
    const bedroomsList = bedrooms
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (bedroomsList.length) {
      if (bedroomsList.includes("12+")) {
        clauses.push(`l.bedrooms >= 12`);
      } else {
        const mins = bedroomsList.filter((v) => /^\d+$/.test(v)).map(Number);
        if (mins.length) {
          const minBedrooms = Math.min(...mins);
          params.push(minBedrooms);
          clauses.push(`l.bedrooms >= $${params.length}`);
        }
      }
    }

    // Bathrooms
    const bathroomsList = bathrooms.split(",").filter(Boolean);
    if (bathroomsList.length) {
      const nums = bathroomsList.filter((v) => /^\d+$/.test(v)).map(Number);
      const has12 = bathroomsList.includes("12+");

      const ORs = [];
      if (nums.length) {
        params.push(nums);
        ORs.push(`l.bathrooms >= ANY($${params.length}::int[])`);
      }
      if (has12) ORs.push(`l.bathrooms >= 12`);

      clauses.push(`(${ORs.join(" OR ")})`);
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
    clauses.push(
      `(l.images_json IS NOT NULL AND l.images_json != '[]'::jsonb)`,
    );

    const whereSQL = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    /***********************
     * ORDERING IDÉNTICO
     ***********************/
    let orderSQL = `ORDER BY l.updated_at DESC`;

    if (sort === "rank") {
      orderSQL = `ORDER BY l.villanet_rank DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === "price_low") {
      orderSQL = `ORDER BY l.price_usd ASC NULLS LAST, l.updated_at DESC`;
    } else if (sort === "price_high") {
      orderSQL = `ORDER BY l.price_usd DESC NULLS LAST, l.updated_at DESC`;
    } else if (sort === "bedrooms") {
      orderSQL = `ORDER BY l.bedrooms DESC NULLS LAST, l.updated_at DESC`;
    }

    /***********************
     * NO-DATES MODE (SIN AVAILABILITY) - PAGINACIÓN SIMPLE IDÉNTICA
     ***********************/
    if (!hasAvailabilityFilter) {
      const offset = (currentPage - 1) * lim;
      const sql = `
        SELECT 
          l.listing_id AS id,
          l.name,
          l.bedrooms,
          l.bathrooms,
          l.price_usd AS "priceUSD",

          l.villanet_rank AS rank,
          COALESCE(l.villanet_destination_tag, l.villanet_city, l.city,'') AS location,

          l.villanet_destination_tag AS "villaNetDestinationTag",
          l.villanet_city AS "villaNetCity",
          l.villanet_property_manager_name AS "villaNetPropertyManagerName",
          l.villanet_commission_rate AS "villaNetCommissionRate",
          l.guesty_booking_domain AS "guestyBookingDomain",
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
        pool.query(countSQL, params),
      ]);

      const total = count.rows[0].total;
      const totalPages = Math.ceil(total / lim);

      console.log(
        `✅ [Privado - No Availability] Page ${currentPage}/${totalPages}, showing ${rows.rows.length} items`,
      );

      return res.json({
        results: normalizeResults(rows.rows),
        total,
        limit: lim,
        offset,
        currentPage,
        totalPages,
        hasMore: currentPage < totalPages,
        availabilityApplied: false,
      });
    }

    /***********************
     * AVAILABILITY MODE - FAST SCAN IDÉNTICO A RUTA PÚBLICA
     ***********************/

    const offset = cursorPos;
    const neededEnd = offset + lim;

    // ✅ Función para gestionar sesiones de availability IDÉNTICA
    const ensureAvailabilitySession = async () => {
      if (cursorPos === 0 || !availabilitySession) {
        const sessionId = `private_av_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

        const session = {
          availableIds: [],
          cursor: 0,
          exhausted: false,
          checkIn,
          checkOut,
          whereSQL,
          orderSQL,
          params: [...params],
          filters: { searchTerm, badgeSlugs, sort },
          createdAt: Date.now(),
          lastAccessed: Date.now(),
        };

        cache.set(
          `private_availability:${sessionId}`,
          session,
          AVAILABILITY_SESSION_TTL,
        );
        return { session, sessionId, isNew: true };
      }

      const session = cache.get(`private_availability:${availabilitySession}`);
      if (!session) {
        throw new Error("Availability session expired");
      }

      if (session.checkIn !== checkIn || session.checkOut !== checkOut) {
        throw new Error("Availability session filters changed");
      }

      session.lastAccessed = Date.now();
      cache.set(
        `private_availability:${availabilitySession}`,
        session,
        AVAILABILITY_SESSION_TTL,
      );

      return { session, sessionId: availabilitySession, isNew: false };
    };

    const { session, sessionId, isNew } = await ensureAvailabilitySession();

    // 🔥 ESTRATEGIA: Full Scan — escanear hasta tener lim resultados o agotar candidatos
    if (isNew || session.availableIds.length < neededEnd) {
      console.log(
        `🔍 [Privado FullScan] Session ${sessionId.slice(0, 12)}: needed ${neededEnd}, have ${session.availableIds.length}`,
      );

      const SCAN_TIMEOUT_MS = 5000;
      const scanStart = Date.now();

      // Loop: seguir escaneando hasta tener suficientes IDs, agotar candidatos o cumplir timeout
      while (session.availableIds.length < neededEnd && !session.exhausted) {
        if (Date.now() - scanStart > SCAN_TIMEOUT_MS) {
          console.warn(
            `⏱️ [Privado FullScan] Timeout alcanzado tras ${SCAN_TIMEOUT_MS}ms. Respondiendo con ${session.availableIds.length} resultados.`,
          );
          break;
        }

        // 1️⃣ Traer siguiente chunk de candidatos
        const idsSQL = `
          SELECT l.listing_id AS id
          FROM listings l
          ${session.whereSQL}
          ${session.orderSQL}
          LIMIT ${LAZY_SCAN_CHUNK} OFFSET ${session.cursor};
        `;

        const idsRes = await pool.query(idsSQL, session.params);
        const candidateIds = idsRes.rows.map((r) => r.id);

        if (candidateIds.length === 0) {
          session.exhausted = true;
          break;
        }

        session.cursor += candidateIds.length;

        // 2️⃣ Verificar disponibilidad desde caché local (CA1: sin llamadas a Guesty)
        const availableInChunk = await checkAvailabilityFromCache(candidateIds, checkIn, checkOut)
          .catch((err) => {
            console.warn(`[Privado FullScan] Cache check failed:`, err.message);
            return [];
          });

        session.availableIds.push(...availableInChunk);
        console.log(
          `📊 [Privado FullScan] Scanned ${candidateIds.length}, found ${availableInChunk.length} available (total: ${session.availableIds.length}/${neededEnd} needed)`,
        );
      }

      // Actualizar sesión
      session.lastAccessed = Date.now();
      cache.set(
        `private_availability:${sessionId}`,
        session,
        AVAILABILITY_SESSION_TTL,
      );
    }

    // 4️⃣ DEVOLVER PÁGINA COMPLETA (o lo que haya si exhausted/timeout)
    const pageIds = session.availableIds.slice(offset, offset + lim);
    const detailRows = await fetchDetails(
      pageIds,
      badgeSlugs,
      VILLANET_BADGE_FIELD_MAP,
    );

    const returned = detailRows.length;
    const nextCursor = offset + returned;

    // hasMore si NO está exhausto O si hay más IDs acumulados
    const hasMore =
      !session.exhausted || nextCursor < session.availableIds.length;

    console.log(
      `✅ [Privado FullScan] Returning ${returned}/${lim} items, cursor ${cursorPos}→${nextCursor}, exhausted: ${session.exhausted}, hasMore: ${hasMore}`,
    );

    return res.json({
      results: normalizeResults(detailRows),
      availabilityApplied: true,
      availabilitySession: sessionId,
      cursor: offset,
      nextCursor,
      requested: lim,
      returned,
      partial: returned < lim && hasMore,
      exhausted: session.exhausted,
      totalScanned: session.cursor,
      totalAvailable: session.availableIds.length,
      currentPage: Math.floor(offset / lim) + 1,
      totalPages: Math.ceil(session.availableIds.length / lim) || 1,
      total: session.availableIds.length,
      hasMore: hasMore,
    });
  } catch (err) {
    console.error("❌ [Privado API] Listings error:", err);

    if (err.message === "Availability session expired") {
      return res.status(400).json({
        message: "Availability session expired. Please refresh your search.",
        expired: true,
      });
    }

    if (err.message === "Availability session filters changed") {
      return res.status(400).json({
        message: "Search filters changed. Starting new availability session.",
        filtersChanged: true,
      });
    }

    if (err.message?.includes("timeout") || err.message?.includes("TIMEOUT")) {
      return res.status(504).json({
        message:
          "Availability check taking too long. Please try a smaller date range.",
        suggestion: "Try narrowing your search criteria",
      });
    }

    res.status(500).json({
      message: "Server error fetching listings",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

/************************************************************
 * GET /listings/:id (PRIVADO – admin/TA/PMC) - Detalles completos
 ************************************************************/
r.get(
  "/:id",
  auth(true),
  requireRole("admin", "ta", "pmc"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const cacheKey = `private:listing:${id}`;

      const cached = cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      // ✅ Incluir todos los campos como en la ruta pública
      const { rows } = await pool.query(
        `SELECT 
        listing_id,
        name,
        bedrooms,
        bathrooms,
        max_guests,
        price_usd,
        lat,
        lng,

        COALESCE(villanet_destination_tag, villanet_city, city,'') AS location,

        description,
        amenities_json AS amenities,
        images_json,
        hero_image_url,

        villanet_rank,
        villanet_commission_rate,
        villanet_destination_tag,
        villanet_city,
        villanet_property_manager_name,
        guesty_booking_domain,
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
        [id],
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Listing not found" });
      }

      const result = rows[0];
      cache.set(cacheKey, result, 600000);
      res.json(result);
    } catch (err) {
      console.error("[Privado API] Listing detail error:", err);
      res
        .status(500)
        .json({ message: err.message || "Error fetching listing detail" });
    }
  },
);

/************************************************************
 * Helpers OPTIMIZADOS IDÉNTICOS a ruta pública
 ************************************************************/

/**
 * Fetch details preservando el orden original
 */
async function fetchDetails(
  ids,
  badgeSlugs = [],
  VILLANET_BADGE_FIELD_MAP = {},
) {
  if (!ids.length) return [];

  // Usar WITH ORDINALITY para preservar el orden de los IDs
  const sql = `
    WITH ordered_ids AS (
      SELECT id, ordinality
      FROM unnest($1::text[]) WITH ORDINALITY AS t(id, ordinality)
    )
    SELECT 
      l.listing_id AS id,
      l.name,
      l.bedrooms,
      l.bathrooms,
      l.price_usd AS "priceUSD",

      l.villanet_rank AS rank,
      COALESCE(l.villanet_destination_tag, l.villanet_city, l.city,'') AS location,

      l.villanet_destination_tag AS "villaNetDestinationTag",
      l.villanet_city AS "villaNetCity",
      l.villanet_property_manager_name AS "villaNetPropertyManagerName",
      l.villanet_commission_rate AS "villaNetCommissionRate",
      l.guesty_booking_domain AS "guestyBookingDomain",
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
      l.updated_at,
      oi.ordinality
    FROM ordered_ids oi
    JOIN listings l ON l.listing_id = oi.id
    ${badgeSlugs.length > 0 ? buildBadgeFilters(badgeSlugs, VILLANET_BADGE_FIELD_MAP) : ""}
    ORDER BY oi.ordinality;
  `;

  const { rows } = await pool.query(sql, [ids]);
  return rows;
}

/**
 * Helper para construir filtros de badges
 */
function buildBadgeFilters(badgeSlugs, VILLANET_BADGE_FIELD_MAP) {
  const validSlugs = badgeSlugs.filter(
    (slug) => VILLANET_BADGE_FIELD_MAP[slug],
  );
  if (validSlugs.length === 0) return "";

  const conditions = validSlugs.map((slug) => {
    const fieldName = VILLANET_BADGE_FIELD_MAP[slug];
    return `l.${fieldName} = true`;
  });

  return `WHERE ${conditions.join(" AND ")}`;
}

/**
 * Normalizar resultados (IDÉNTICO a ruta pública)
 */
function normalizeResults(rows) {
  const PLACEHOLDER =
    "https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200";

  return rows.map((r) => {
    const normalizeBoolean = (value) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        return (
          value.toLowerCase() === "true" ||
          value.toLowerCase() === "yes" ||
          value === "1"
        );
      }
      return Boolean(value);
    };

    // Remover el campo ordinality si existe
    const { ordinality, ...rest } = r;

    return {
      ...rest,
      // 1. ELIMINAR "Unknown" de campos de texto
      location: r.location && r.location !== "Unknown" ? r.location : "",
      propertyManager:
        r.villanet_property_manager_name &&
        r.villanet_property_manager_name !== "Unknown"
          ? r.villanet_property_manager_name
          : "",

      // 2. NORMALIZAR DESTINOS (Evitar "Unknown")
      villaNetCity:
        r.villanet_city && r.villanet_city !== "Unknown" ? r.villanet_city : "",
      villaNetDestinationTag:
        r.villanet_destination_tag && r.villanet_destination_tag !== "Unknown"
          ? r.villanet_destination_tag
          : "",

      // 3. LIMPIEZA DE IMAGES_JSON (A veces se guardan tags aquí por error)
      images_json: Array.isArray(r.images_json)
        ? r.images_json.filter(
            (img) => img !== "Unknown" && img !== "Villas not verified",
          ).slice(0, 3)
        : [],

      // 4. VERIFICACIÓN (Solo booleano, sin textos de advertencia)
      trustAccount: !!r.trust_account,

      rank: r.rank !== null ? Number(r.rank) : null,
      
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
      villanetWaiterButlerIncluded: normalizeBoolean(
        r.villanetWaiterButlerIncluded,
      ),
      villanetOceanFront: normalizeBoolean(r.villanetOceanFront),
      villanetWalkToBeach: normalizeBoolean(r.villanetWalkToBeach),
      villanetAccessible: normalizeBoolean(r.villanetAccessible),
      villanetGatedCommunity: normalizeBoolean(r.villanetGatedCommunity),
      villanetGolfVilla: normalizeBoolean(r.villanetGolfVilla),
      villanetResortVilla: normalizeBoolean(r.villanetResortVilla),
    };
  });
}


/**
 * checkAvailabilityFromCache
 * Reemplaza getAvailabilityFor() consultando listing_availability en DB.
 * CA1: sin llamadas a Guesty. CA2: respuesta <1s. CA3: lógica correcta de CTA/CTD/minNights.
 * CA4: propiedades sin datos en caché no aparecen.
 *
 * @param {string[]} candidateIds
 * @param {string} checkIn  YYYY-MM-DD
 * @param {string} checkOut YYYY-MM-DD
 * @returns {Promise<string[]>} IDs disponibles
 */
async function checkAvailabilityFromCache(candidateIds, checkIn, checkOut) {
  if (!candidateIds.length) return [];

  const checkInDate  = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const nights = Math.round((checkOutDate - checkInDate) / 86400000);
  if (nights <= 0) return [];

  const t0 = Date.now();

  const { rows } = await pool.query(`
    SELECT la.listing_id
    FROM listing_availability la
    WHERE la.listing_id = ANY($1::text[])
      AND la.date >= $2
      AND la.date < $3
      AND la.available = true
      AND la.cta = false
      AND la.ctd = false
    GROUP BY la.listing_id
    HAVING
      COUNT(*) = $4
      AND MIN(CASE WHEN la.date = $2 THEN la.min_nights ELSE NULL END) <= $4
  `, [candidateIds, checkIn, checkOut, nights]);

  const ms = Date.now() - t0;
  console.log(`⚡ [checkAvailabilityFromCache] ${rows.length}/${candidateIds.length} disponibles en ${ms}ms`);

  return rows.map(r => r.listing_id);
}

export default r;