import { pool } from '../db.js';
import {
  fetchAllListings,
  fetchListingById,
  mapListingMinimal,
  extractImageUrlsFromListing,
  extractDetailFields, // <- prioriza marketingDescription.primary.body
} from './guesty.service.js';

export async function syncGuestyListings() {
  console.log('[SYNC] Starting Guesty listings sync...');

  const token = process.env.GUESTY_TOKEN;
  const limit = Number(process.env.GUESTY_LIMIT || 200);

  // 1) Traer todo desde Guesty
  const all = await fetchAllListings(token, limit);
  console.log('[SYNC] Guesty returned:', all.length);

  // Filtro conservador: sólo excluye si detectamos inactividad con certeza
  const looksInactive = (l) => {
    const cand = String(
      l?.status ?? l?.state ?? l?.publishedStatus ?? l?.listingStatus ?? ''
    ).toLowerCase();

    const INACTIVE = [
      'inactive', 'unlisted', 'archived', 'blocked', 'paused',
      'draft', 'hidden', 'disabled', 'unavailable'
    ];
    if (INACTIVE.some(w => cand.includes(w))) return true;

    if (typeof l?.isActive === 'boolean') return !l.isActive;
    if (typeof l?.is_listed === 'boolean') return !l.is_listed;

    // si no podemos afirmar que está inactivo, NO lo filtramos
    return false;
  };

  const raw = all.filter(l => !looksInactive(l));
  console.log('[SYNC] After conservative filter (active-ish):', raw.length);

  let upserts = 0;

  // 2) Upsert básico (sin detalle)
  for (const l of raw) {
    const m = mapListingMinimal(l);

    const beds  = Number.isFinite(Number(m.bedrooms)) ? Math.trunc(Number(m.bedrooms)) : null;
    const baths = Number.isFinite(Number(m.bathrooms)) ? Number(parseFloat(String(m.bathrooms)).toFixed(1)) : null;
    const price = Number.isFinite(Number(m.priceUSD))  ? Number(parseFloat(String(m.priceUSD)).toFixed(2))  : null;

    const city      = l?.address?.city ?? null;
    const country   = l?.address?.country ?? null;
    const minNights = l?.availabilityRules?.minNights ?? null;
    const tz        = l?.timeZone || l?.timezone || null;

    // is_listed se determina por “no luce inactivo”
    const isListed  = !looksInactive(l);

    // imágenes desde el listado
    const images = extractImageUrlsFromListing(l) || [];
    const hero   = m.heroImage || (images[0] ?? null);

    await pool.query(`
      INSERT INTO public.listings (
        listing_id, name, bedrooms, bathrooms, price_usd,
        location_text, city, country, min_nights, is_listed,
        timezone, hero_image_url, images_json,
        source_updated_at, updated_at, has_detail
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW(),false)
      ON CONFLICT (listing_id) DO UPDATE SET
        name              = EXCLUDED.name,
        bedrooms          = EXCLUDED.bedrooms,
        bathrooms         = EXCLUDED.bathrooms,
        price_usd         = EXCLUDED.price_usd,
        location_text     = EXCLUDED.location_text,
        city              = COALESCE(EXCLUDED.city, public.listings.city),
        country           = COALESCE(EXCLUDED.country, public.listings.country),
        min_nights        = COALESCE(EXCLUDED.min_nights, public.listings.min_nights),
        is_listed         = COALESCE(EXCLUDED.is_listed, public.listings.is_listed),
        timezone          = COALESCE(EXCLUDED.timezone, public.listings.timezone),
        hero_image_url    = EXCLUDED.hero_image_url,
        images_json       = EXCLUDED.images_json,
        source_updated_at = NOW(),
        updated_at        = NOW();
    `, [
      m.id, m.name, beds, baths, price,
      m.location ?? null, city, country, minNights, isListed,
      tz, hero, JSON.stringify(images)
    ]);

    upserts++;
  }

  // 3) Completar detalle sólo para los que lo necesitan (lotes para evitar 429)
  const { rows: needDetail } = await pool.query(`
    SELECT listing_id FROM public.listings
    WHERE has_detail = false
    ORDER BY updated_at DESC
    LIMIT 60;  -- ajustá según tolerancia de rate limit
  `);

  let completed = 0;

  for (const row of needDetail) {
    try {
      const d = await fetchListingById(token, row.listing_id);
      if (!d) continue;

      // descripción de marketing + amenities
      const { description, amenities } = extractDetailFields(d);

      // merge/replace imágenes si el detalle trae más
      const moreImgs = extractImageUrlsFromListing(d) || [];

      await pool.query(`
        UPDATE public.listings
           SET description    = COALESCE($2, description),
               amenities_json = COALESCE($3::jsonb, amenities_json),
               images_json    = CASE
                                  WHEN jsonb_array_length($4::jsonb) = 0
                                    THEN images_json
                                  ELSE $4::jsonb
                                END,
               hero_image_url = COALESCE(hero_image_url, ($4::jsonb->>0)),
               has_detail     = true,
               updated_at     = NOW()
         WHERE listing_id = $1;
      `, [
        row.listing_id,
        description ?? null,
        JSON.stringify(amenities || []),
        JSON.stringify(moreImgs || [])
      ]);

      completed++;
    } catch (e) {
      // si Guesty rate-limitea, seguimos con el resto
      continue;
    }
  }

  // 4) Normalizaciones de seguridad
  await pool.query(`UPDATE public.listings SET images_json = '[]'::jsonb    WHERE images_json    IS NULL;`);
  await pool.query(`UPDATE public.listings SET amenities_json = '[]'::jsonb WHERE amenities_json IS NULL;`);

  console.log(`[SYNC] Listings upserted: ${upserts}, detail completed for: ${completed}`);
  return upserts;
}
