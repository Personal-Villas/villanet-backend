import pLimit from 'p-limit';
import { guesty } from './guestyClient.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const keyOf = (ids, from, to) => `avail:${[...ids].sort().join(',')}:${from}:${to}`;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.data;
}

function cacheSet(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function normalizeDay(d = {}) {
  // Fecha
  const date = d.date || d.day || d.startDate || (typeof d.start === 'string' ? d.start : null);
  
  // Precio
  const price = Number.isFinite(+d.price) ? +d.price : null;
  
  // Disponibilidad/Allotment
  let allotment = null;
  if (Number.isFinite(+d.allotment)) {
    allotment = +d.allotment;
  } else if (typeof d.availableUnits === 'number') {
    allotment = d.availableUnits;
  } else if (d.status === 'available' && !d.blocks) {
    // Si no hay allotment pero está available, asumimos 1
    allotment = 1;
  }
  
  // Status
  let status = d.status;
  if (!status) {
    // Si hay blocks, verificar si está bloqueado
    const hasBlocks = d.blocks && Object.values(d.blocks).some(v => v === true);
    status = hasBlocks ? 'unavailable' : (allotment != null && allotment > 0 ? 'available' : 'unavailable');
  }
  
  // Check-in/out permitidos
  const cta = d.cta ?? d.checkInAllowed ?? true;
  const ctd = d.ctd ?? d.checkOutAllowed ?? true;
  
  // Min nights
  const minStay = d.minNights ?? d.minStay ?? d.baseMinNights ?? 1;
  
  return { 
    date, 
    price, 
    allotment, 
    status, 
    cta, 
    ctd, 
    minStay 
  };
}

function normalizeCalendarResponse(data, requestedIds = []) {
  const out = [];
  
  // 🔧 CASO 1: Respuesta con data.days (formato Guesty para calendar/listings)
  // Ejemplo: { status: 200, data: { days: [{date, listingId, price, ...}, ...] } }
  if (data?.data?.days && Array.isArray(data.data.days)) {
    console.log('[normalizeCalendarResponse] Format: data.days array');
    
    // Agrupar días por listingId
    const byListing = new Map();
    
    data.data.days.forEach(day => {
      const listingId = String(day.listingId || day.id || day._id || '');
      if (!listingId) return;
      
      if (!byListing.has(listingId)) {
        byListing.set(listingId, []);
      }
      byListing.get(listingId).push(normalizeDay(day));
    });
    
    // Convertir a formato esperado
    byListing.forEach((days, listingId) => {
      out.push({ listingId, days });
    });
    
    console.log(`[normalizeCalendarResponse] Extracted ${out.length} listings from days array`);
    return out;
  }
  
  // 🔧 CASO 2: Respuesta como array de listings (formato legacy)
  const pushOne = (x) => {
    if (!x) return;
    const listingId = x.listingId || x.id || x._id || null;
    const rawDays = x.days || x.calendar || x.availability || [];
    const days = Array.isArray(rawDays) ? rawDays.map(normalizeDay) : [];
    if (listingId) out.push({ listingId: String(listingId), days });
  };
  
  if (Array.isArray(data)) {
    console.log('[normalizeCalendarResponse] Format: array of listings');
    data.forEach(pushOne);
  } else if (data?.data && Array.isArray(data.data)) {
    console.log('[normalizeCalendarResponse] Format: data array');
    data.data.forEach(pushOne);
  } else if (data?.data && typeof data.data === 'object') {
    console.log('[normalizeCalendarResponse] Format: data object');
    pushOne(data.data);
  } else if (data && typeof data === 'object') {
    console.log('[normalizeCalendarResponse] Format: root object');
    pushOne(data);
  }
  
  return out;
}

// === SINGLE BATCH - FIX AQUÍ ===
async function fetchBatch(ids, from, to) {
  try {
    console.log(`[fetchBatch] Requesting ${ids.length} listings from ${from} to ${to}`);
    console.log(`[fetchBatch] IDs:`, ids.slice(0, 3), ids.length > 3 ? '...' : '');
    
    // 🔧 SOLUCIÓN: Construir manualmente la query string como en Postman
    const queryParts = [];
    
    // Agregar cada listingId como listingIds[]=value
    ids.forEach(id => {
      queryParts.push(`listingIds[]=${encodeURIComponent(String(id))}`);
    });
    
    // Agregar fechas
    queryParts.push(`startDate=${encodeURIComponent(from)}`);
    queryParts.push(`endDate=${encodeURIComponent(to)}`);
    
    const queryString = queryParts.join('&');
    const url = `/v1/availability-pricing/api/calendar/listings?${queryString}`;
    
    console.log('[fetchBatch] Full URL:', url);
    
    const { data, config } = await guesty.get(url);

    if (config?.url) {
      console.log('[fetchBatch] Full URL:', config.url);
    }

    const result = normalizeCalendarResponse(data);
    console.log(`[fetchBatch] ✅ Success: ${result.length} listings returned (expected ${ids.length})`);
    
    if (result.length === 0) {
      console.warn('[fetchBatch] ⚠️ Response returned 0 listings');
      console.log('[fetchBatch] Raw data structure:', JSON.stringify(data).slice(0, 200));
    }
    
    return result;
  } catch (err) {
    const status = err?.response?.status;
    
    if (err.message?.includes('OAuth bloqueado')) {
      console.error('[fetchBatch] OAuth bloqueado:', err.message);
    }
    
    console.error('[fetchBatch] ❌ Failed:', { 
      status, 
      message: err?.message,
      data: err?.response?.data 
    });
    throw err;
  }
}

function isRangeAvailable(days) {
  if (!Array.isArray(days) || days.length === 0) return false;
  return days.every(d => {
    const allotment = Number.isFinite(+d?.allotment) ? +d.allotment : null;
    return allotment != null ? allotment > 0 : d?.status === 'available';
  });
}

function computeNightlyFrom(days) {
  const prices = days.map(d => +d.price).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}

// === BATCH SUMMARY ===
export async function getAvailabilityFor(ids, from, to) {
  if (!ids || ids.length === 0) return [];
  
  const key = keyOf(ids, from, to);
  const cached = cacheGet(key);
  if (cached) { 
    console.log(`[getAvailabilityFor] Cache hit (${ids.length})`); 
    return cached; 
  }
  
  if (inflight.has(key)) { return inflight.get(key); }
  
  const p = (async () => {
    try {
      const limit = pLimit(2);
      const batches = chunk(ids, 40);
      
      const pieces = await Promise.all(
        batches.map(b => limit(() => fetchBatch(b, from, to)))
      );
      
      const map = new Map();
      for (const arr of pieces) {
        for (const item of arr) {
          const id = String(item.listingId);
          map.set(id, Array.isArray(item.days) ? item.days : []);
        }
      }
      
      const result = ids.map(idRaw => {
        const id = String(idRaw);
        const days = map.get(id) || [];
        return { 
          listing_id: id, 
          available: isRangeAvailable(days), 
          nightlyFrom: computeNightlyFrom(days) 
        };
      });
      
      cacheSet(key, result);
      return result;
    } finally {
      inflight.delete(key);
    }
  })();
  
  inflight.set(key, p);
  return p;
}

// === DAYS cache para detalle ===
const DAYS_TTL_MS = 10 * 60 * 1000;
const daysCache = new Map();
const daysInflight = new Map();
const daysKey = (id, from, to) => `days:${id}:${from}:${to}`;

function daysGet(key) {
  const hit = daysCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { daysCache.delete(key); return null; }
  return hit.data;
}

function daysSet(key, data, ttl = DAYS_TTL_MS) {
  daysCache.set(key, { data, expires: Date.now() + ttl });
}

export async function getDaysForListing(id, from, to) {
  const key = daysKey(id, from, to);
  const cached = daysGet(key);
  if (cached) {
    console.log(`[getDaysForListing] ✅ Cache hit for ${id}`);
    return cached;
  }
  
  if (daysInflight.has(key)) return daysInflight.get(key);
  
  const p = (async () => {
    try {
      const arr = await fetchBatch([String(id)], from, to);
      const entry = Array.isArray(arr) ? arr.find(x => String(x.listingId) === String(id)) : null;
      const days = entry && Array.isArray(entry.days) ? entry.days : [];
      
      daysSet(key, days);
      console.log(`[getDaysForListing] ✅ Fetched ${days.length} days for ${id}`);
      return days;
    } finally {
      daysInflight.delete(key);
    }
  })();
  
  daysInflight.set(key, p);
  return p;
}