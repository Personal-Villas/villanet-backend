// services/availability.service.js
import pLimit from 'p-limit';
import { guesty } from './guestyClient.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map();             // key -> { data, expires }
const inflight = new Map();          // key -> Promise

const keyOf = (ids, from, to) => `avail:${[...ids].sort().join(',')}:${from}:${to}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
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

/** Normaliza una entrada de día (Guesty puede cambiar nombres) */
function normalizeDay(d = {}) {
  const date =
    d.date || d.day || d.startDate || (typeof d.start === 'string' ? d.start : null);
  const price = Number.isFinite(+d.price) ? +d.price : null;

  let allotment = null;
  if (Number.isFinite(+d.allotment)) allotment = +d.allotment;
  else if (typeof d.availableUnits === 'number') allotment = d.availableUnits;

  const status = d.status ?? (allotment != null ? (allotment > 0 ? 'available' : 'unavailable') : null);

  const cta = d.cta ?? d.checkInAllowed ?? null;
  const ctd = d.ctd ?? d.checkOutAllowed ?? null;

  return { date, price, allotment, status, cta, ctd };
}

/** Extrae [{ listingId, days[] }] de cualquier forma de respuesta */
function normalizeCalendarResponse(data) {
  const candidates = [];

  const tryPush = (x) => {
    if (!x) return;
    const listingId = x.listingId || x.id || x._id || null;
    const rawDays = x.days || x.calendar || x.availability || [];
    const days = Array.isArray(rawDays) ? rawDays.map(normalizeDay) : [];
    if (listingId) candidates.push({ listingId: String(listingId), days });
  };

  if (Array.isArray(data)) {
    data.forEach(tryPush);
  } else if (data?.data && Array.isArray(data.data)) {
    data.data.forEach(tryPush);
  } else if (data?.data && typeof data.data === 'object') {
    tryPush(data.data);
  } else if (data && typeof data === 'object') {
    tryPush(data);
  }

  return candidates;
}

/** Llama al batch calendar de Guesty con retry/backoff y manejo de 429 */
async function fetchBatch(ids, from, to, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[fetchBatch] Attempt ${attempt + 1}/${retries + 1} for ${ids.length} listings`);

      const { data } = await guesty.get(
        '/v1/availability-pricing/api/calendar/listings',
        {
          params: { listingIds: ids.join(','), startDate: from, endDate: to },
          timeout: 15000,
        }
      );

      const result = normalizeCalendarResponse(data);
      console.log(`[fetchBatch] Success: ${result.length} listings returned`);
      return result;
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;
      const msg = err?.message;
      const code = err?.code;

      console.error(`[fetchBatch] Attempt ${attempt + 1} failed:`, { code, message: msg, status });

      // No reintentar en ciertos errores
      if (code === 'ENOTFOUND') break;
      if (status === 401 || status === 403 || status === 422) break;

      if (attempt < retries) {
        // Respeta Retry-After si viene en 429
        let delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        if (status === 429) {
          const ra = err?.response?.headers?.['retry-after'];
          const hinted = Number(ra);
          if (Number.isFinite(hinted) && hinted > 0) {
            delay = Math.min(hinted * 1000, 15000);
          }
        }
        delay += Math.floor(Math.random() * 250); // jitter
        console.log(`[fetchBatch] Waiting ${delay}ms before retry...`);
        await sleep(delay);
      }
    }
  }

  console.error('[fetchBatch] All attempts failed:', lastError?.message);
  throw lastError;
}

/** Regla "disponible" para un rango completo */
function isRangeAvailable(days) {
  if (!Array.isArray(days) || days.length === 0) return false;
  return days.every(d => {
    const allotment = Number.isFinite(+d?.allotment) ? +d.allotment : null;
    const statusOk = allotment != null ? allotment > 0 : d?.status === 'available';
    return statusOk;
  });
}

/** Precio mínimo dentro del rango */
function computeNightlyFrom(days) {
  const prices = days.map(d => +d.price).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Batch: devuelve resumen por listing
 * [{ listing_id, available, nightlyFrom }]
 */
export async function getAvailabilityFor(ids, from, to) {
  if (!ids || ids.length === 0) return [];

  const key = keyOf(ids, from, to);
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[getAvailabilityFor] Cache hit for ${ids.length} listings`);
    return cached;
  }

  if (inflight.has(key)) {
    console.log(`[getAvailabilityFor] Waiting for inflight request`);
    return inflight.get(key);
  }

  const p = (async () => {
    try {
      // Concurrencia interna controlada; además, cada request ya pasa por guestyLimiter
      const limit = pLimit(3);
      const batches = chunk(ids, 50);

      console.log(`[getAvailabilityFor] Fetching ${ids.length} listings in ${batches.length} batches`);

      const pieces = await Promise.all(
        batches.map(b => limit(() => fetchBatch(b, from, to)))
      );

      // Unificar resultados por listingId
      const map = new Map(); // listingId -> days[]
      for (const arr of pieces) {
        for (const item of arr) {
          const id = String(item.listingId);
          map.set(id, Array.isArray(item.days) ? item.days : []);
        }
      }

      // Respuesta final, respetando orden de entrada
      const result = ids.map(idRaw => {
        const id = String(idRaw);
        const days = map.get(id) || [];
        return {
          listing_id: id,
          available: isRangeAvailable(days),
          nightlyFrom: computeNightlyFrom(days),
        };
      });

      cacheSet(key, result);
      console.log(`[getAvailabilityFor] Success: ${result.length} results cached`);
      return result;
    } catch (err) {
      console.error('[getAvailabilityFor] Fatal error:', {
        code: err?.code,
        message: err?.message,
        status: err?.response?.status,
      });

      // No romper el flujo del cliente
      return ids.map(id => ({
        listing_id: String(id),
        available: null,
        nightlyFrom: null,
        error: true,
        errorCode: err?.code || 'UNKNOWN',
        status: err?.response?.status ?? null,
      }));
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

// === Cache de DAYS por listingId+rango (para detalle) ===
const DAYS_TTL_MS = 10 * 60 * 1000; // 10 min
const daysCache = new Map();        // key -> { data, expires }
const daysInflight = new Map();     // key -> Promise
const daysKey = (id, from, to) => `days:${id}:${from}:${to}`;

function daysGet(key) {
  const hit = daysCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    daysCache.delete(key);
    return null;
  }
  return hit.data;
}

function daysSet(key, data, ttl = DAYS_TTL_MS) {
  daysCache.set(key, { data, expires: Date.now() + ttl });
}

/**
 * Days para UN listing (usa el mismo fetchBatch bajo el capó)
 */
export async function getDaysForListing(id, from, to) {
  const key = daysKey(id, from, to);
  const cached = daysGet(key);
  if (cached) return cached;

  if (daysInflight.has(key)) return daysInflight.get(key);

  const p = (async () => {
    try {
      const arr = await fetchBatch([String(id)], from, to);
      const entry = Array.isArray(arr) ? arr.find(x => String(x.listingId) === String(id)) : null;
      const days = entry && Array.isArray(entry.days) ? entry.days : [];
      daysSet(key, days);
      return days;
    } finally {
      daysInflight.delete(key);
    }
  })();

  daysInflight.set(key, p);
  return p;
}
