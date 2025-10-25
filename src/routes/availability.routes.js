import { Router } from 'express';
import { pool } from '../db.js';
import { getAvailabilityFor } from '../services/availability.service.js';
import { guesty } from '../services/guestyClient.js';

const r = Router();

/** Helper para logs detallados de errores */
function logError(context, error) {
  console.error(`[${context}] Error:`, {
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    data: error?.response?.data,
    // Errores de red
    errno: error?.errno,
    syscall: error?.syscall,
    hostname: error?.hostname,
  });
}

/**
 * GET /availability?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&bbox=n,w,s,e
 * o /availability?city=Miami&checkIn=...&checkOut=...
 */
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

    // Este servicio ya mapea a startDate/endDate internamente
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
      message:
        e.code === 'ENOTFOUND'
          ? 'Unable to connect to availability service'
          : 'Upstream error',
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
  
      // 1) Intento principal contra Guesty (Open API: startDate/endDate)
      let days = [];
      try {
        const response = await guesty.get(
          '/v1/availability-pricing/api/calendar/listings',
          { params: { listingIds: id, startDate: from, endDate: to }, timeout: 10000 }
        );
        
        // 🔍 DEBUG: Ver la estructura COMPLETA de la respuesta
        console.log('🔍 Tipo de response.data:', typeof response.data);
        console.log('🔍 Es array?:', Array.isArray(response.data));
        console.log('🔍 Keys de response.data:', Object.keys(response.data || {}));
        console.log('🔍 Estructura completa de response.data:', JSON.stringify(response.data, null, 2));
        
        // CORRECCIÓN PRINCIPAL: Manejar la estructura real de la respuesta
        let raw = [];
        
        if (response.data?.data?.days && Array.isArray(response.data.data.days)) {
          // CASO CORREGIDO: response.data.data.days (basado en los logs)
          raw = response.data.data.days;
          console.log('✅ Caso corregido: response.data.data.days');
        } else if (Array.isArray(response.data)) {
          // Caso 1: Array directo
          raw = response.data;
          console.log('✅ Caso 1: Array directo');
        } else if (response.data?.data && Array.isArray(response.data.data)) {
          // Caso 2: Envuelto en data.data
          raw = response.data.data;
          console.log('✅ Caso 2: Envuelto en data.data');
        } else if (response.data?.days && Array.isArray(response.data.days)) {
          // Caso 3: Envuelto en data.days
          raw = response.data.days;
          console.log('✅ Caso 3: Envuelto en data.days');
        } else if (response.data?.[0]?.days && Array.isArray(response.data[0].days)) {
          // Caso 4: Array de objetos con days
          raw = response.data[0].days;
          console.log('✅ Caso 4: Array[0].days');
        } else {
          console.log('❌ No se pudo identificar la estructura de los datos');
          console.log('🔍 Estructura disponible:', Object.keys(response.data || {}));
        }
        
        console.log(`[availability/:id] Success: ${raw.length} days received from Guesty`);
        
        if (raw.length > 0) {
          console.log('🔍 Estructura del primer día:', JSON.stringify(raw[0], null, 2));
        }
        
        // Mapear a tu formato - CORREGIDO para usar minNights
        days = raw.map(d => ({
          date: d.date || d.day || d.startDate,
          status: d.status ?? null,
          allotment: Number.isFinite(+d.allotment) ? +d.allotment : null,
          price: Number.isFinite(+d.price) ? +d.price : null,
          cta: d.cta ?? d.checkInAllowed ?? null,
          ctd: d.ctd ?? d.checkOutAllowed ?? null,
          minStay: d.minNights ?? d.minStay ?? d.minimumStay ?? null, // minNights es el campo correcto
        }));
        
        console.log(`[availability/:id] Mapped ${days.length} days successfully`);
        if (days.length > 0) {
          console.log('Sample mapped day:', days[0]);
          // Verificar específicamente minStay
          console.log('🔍 minStay en primer día:', days[0].minStay);
        }
      } catch (e) {
        logError('availability/:id -> guesty', e);
        // Si falla Guesty, seguimos a fallback
      }
  
      // 2) Fallback: si 0 días, generamos calendario con precio base de la BD
      if (days.length === 0) {
        console.log('[availability/:id] No data from Guesty, using fallback');
        const base = await pool.query(
          `SELECT price_usd FROM public.listings WHERE listing_id = $1 LIMIT 1`,
          [id]
        );
        const basePrice = Number(base?.rows?.[0]?.price_usd) || null;
  
        const start = new Date(from);
        const end   = new Date(to);
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
            _source: 'fallback',
          });
        }
        days = out;
        console.log(`[availability/:id] Fallback generated ${days.length} days`);
      }
  
      return res.json({ listing_id: id, from, to, days });
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