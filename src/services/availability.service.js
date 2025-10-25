import pLimit from 'p-limit';
import { guesty } from './guestyClient.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map();
const inflight = new Map();

const keyOf = (ids, from, to) => `avail:${ids.sort().join(',')}:${from}:${to}`;

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

/** Llama al batch calendar de Guesty con retry */
async function fetchBatch(ids, from, to, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(
        `[fetchBatch] Attempt ${attempt + 1}/${retries + 1} for ${ids.length} listings`
      );

      const { data } = await guesty.get(
        '/v1/availability-pricing/api/calendar/listings',
        {
          // 👇 Open API exige startDate / endDate
          params: { listingIds: ids.join(','), startDate: from, endDate: to },
          timeout: 15000,
        }
      );

      // Guesty puede devolver {data:[...]} o lista directa según entorno
      const result = (data?.data ?? data ?? []).map(x => ({
        listingId: x.listingId || x.id,
        days: x.days || x.calendar || [],
      }));

      console.log(`[fetchBatch] Success: ${result.length} listings returned`);
      return result;
    } catch (err) {
      lastError = err;
      console.error(`[fetchBatch] Attempt ${attempt + 1} failed:`, {
        code: err.code,
        message: err.message,
        status: err.response?.status,
      });

      // No reintentar en ciertos errores
      if (err.code === 'ENOTFOUND') {
        console.error('[fetchBatch] DNS resolution failed - network issue');
        break;
      }
      if (err.response?.status === 401 || err.response?.status === 403) {
        console.error('[fetchBatch] Authentication error - not retrying');
        break;
      }
      if (err.response?.status === 422) {
        console.error('[fetchBatch] Validation error - not retrying');
        break;
      }

      // Esperar antes de reintentar
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // backoff exponencial
        console.log(`[fetchBatch] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Si llegamos aquí, todos los intentos fallaron
  console.error('[fetchBatch] All attempts failed:', lastError?.message);
  throw lastError;
}

/** Regla "disponible" para un rango */
function isRangeAvailable(days) {
  if (!Array.isArray(days) || days.length === 0) return false;
  return days.every(d => {
    const allotment = Number.isFinite(+d?.allotment) ? +d.allotment : null;
    const statusOk =
      allotment != null ? allotment > 0 : d?.status === 'available';
    return statusOk;
  });
}

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
      const limit = pLimit(3); // concurrencia
      const batches = chunk(ids, 50); // tamaño de batch

      console.log(
        `[getAvailabilityFor] Fetching ${ids.length} listings in ${batches.length} batches`
      );

      const pieces = await Promise.all(
        batches.map(b => limit(() => fetchBatch(b, from, to)))
      );

      // Unificar
      const map = new Map();
      for (const arr of pieces) {
        for (const item of arr) map.set(item.listingId, item.days || []);
      }

      // Reducir a resultado final
      const result = ids.map(id => {
        const days = map.get(id) || [];
        const available = isRangeAvailable(days);
        const nightlyFrom = (() => {
          const prices = days.map(d => +d.price).filter(Number.isFinite);
          return prices.length ? Math.min(...prices) : null;
        })();
        return { listing_id: id, available, nightlyFrom };
      });

      cacheSet(key, result);
      console.log(
        `[getAvailabilityFor] Success: ${result.length} results cached`
      );
      return result;
    } catch (err) {
      console.error('[getAvailabilityFor] Fatal error:', {
        code: err.code,
        message: err.message,
        status: err.response?.status,
      });

      // Devolver estructura de error pero no romper
      return ids.map(id => ({
        listing_id: id,
        available: null,
        nightlyFrom: null,
        error: true,
        errorCode: err.code || 'UNKNOWN',
      }));
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}
