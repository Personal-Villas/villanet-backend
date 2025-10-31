import { Router } from 'express';
import { pool } from '../db.js';
import { getAvailabilityFor, getDaysForListing } from '../services/availability.service.js';

const r = Router();

function logError(context, error) {
  console.error(`[${context}] Error:`, {
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    data: error?.response?.data,
    errno: error?.errno,
    syscall: error?.syscall,
    hostname: error?.hostname,
  });
}

r.get('/', async (req, res) => {
  try {
    const { checkIn, checkOut, bbox, city } = req.query;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn y checkOut son requeridos' });
    }

    let idsQuery;
    const args = [];

    if (bbox) {
      const [n, w, s, e] = String(bbox).split(',').map(Number);
      idsQuery = `
        SELECT listing_id, lat, lng, hero_image_url, price_usd, name 
        FROM public.listings 
        WHERE is_listed = true 
          AND lat BETWEEN $1 AND $2 
          AND lng BETWEEN $3 AND $4
      `;
      args.push(s, n, w, e);
    } else if (city) {
      idsQuery = `
        SELECT listing_id, lat, lng, hero_image_url, price_usd, name 
        FROM public.listings 
        WHERE is_listed = true 
          AND LOWER(city) = LOWER($1)
      `;
      args.push(city);
    } else {
      idsQuery = `
        SELECT listing_id, lat, lng, hero_image_url, price_usd, name 
        FROM public.listings 
        WHERE is_listed = true 
        LIMIT 300
      `;
    }

    const { rows } = await pool.query(idsQuery, args);
    const ids = rows.map(r => r.listing_id);

    const avail = await getAvailabilityFor(ids, checkIn, checkOut);
    const byId = new Map(avail.map(a => [a.listing_id, a]));

    const items = rows.map(r => {
      const a = byId.get(r.listing_id) || {};
      return {
        listing_id: r.listing_id,
        name: r.name,
        lat: r.lat,
        lng: r.lng,
        hero_image_url: r.hero_image_url,
        price_usd: r.price_usd,
        available: a.available,
        nightlyFrom: a.nightlyFrom ?? r.price_usd,
      };
    });

    res.json({ items, from: checkIn, to: checkOut });
  } catch (e) {
    logError('availability', e);
    res.status(502).json({
      error: 'availability_failed',
      message: e.code === 'ENOTFOUND' ? 'Unable to connect to availability service' : 'Upstream error',
    });
  }
});

// GET /availability/:id?from=YYYY-MM-DD&to=YYYY-MM-DD
r.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'Debe especificar from y to (YYYY-MM-DD)' });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || !dateRegex.test(to)) {
      return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD' });
    }

    console.log(`[availability/:id] Fetching for ${id} from ${from} to ${to}`);

    let days = [];
    let errorReason = null;
    
    try {
      days = await getDaysForListing(id, from, to);
      console.log(`[availability/:id] Success: ${days.length} days`);
      if (days.length) console.log('🔍 first day:', days[0]);
    } catch (e) {
      logError('availability/:id -> guesty', e);
      
      // Detectar si es error de OAuth bloqueado
      if (e.message?.includes('OAuth bloqueado') || e.message?.includes('Rate limit')) {
        errorReason = 'oauth_rate_limited';
        console.warn('[availability/:id] ⚠️ OAuth rate limited, usando fallback');
      } else if (e?.response?.status === 429) {
        errorReason = 'api_rate_limited';
        console.warn('[availability/:id] ⚠️ API rate limited, usando fallback');
      }
    }

    // Fallback si no hay datos
    if (days.length === 0) {
      console.log('[availability/:id] No data from Guesty, using fallback');
      
      const base = await pool.query(
        `SELECT price_usd FROM public.listings WHERE listing_id = $1 LIMIT 1`,
        [id]
      );
      
      const basePrice = Number(base?.rows?.[0]?.price_usd) || null;
      const start = new Date(from);
      const end = new Date(to);
      const out = [];

      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const ymd = d.toISOString().slice(0, 10);
        out.push({
          date: ymd,
          status: 'available',
          allotment: 1,
          price: basePrice,
          cta: true,
          ctd: true,
          minStay: 1,
          _source: errorReason || 'fallback',
        });
      }

      days = out;
      console.log(`[availability/:id] Fallback generated ${days.length} days`);
    }

    return res.json({ 
      listing_id: id, 
      from, 
      to, 
      days,
      // Incluir info de por qué se usó fallback (útil para debugging)
      ...(errorReason && { fallback_reason: errorReason })
    });
  } catch (e) {
    logError('availability/:id (outer)', e);
    const status = e?.response?.status;
    const msg = e?.response?.data?.message;

    if (status === 422) return res.status(422).json({ error: 'upstream_validation', message: msg || 'Invalid date range' });
    if (status === 401 || status === 403) return res.status(502).json({ error: 'guesty_unauthorized' });
    if (e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') {
      return res.status(502).json({ error: 'network_error' });
    }

    return res.status(502).json({ error: 'availability_upstream_failed' });
  }
});

export default r;
