import pLimit from 'p-limit';
import { guesty } from './guestyClient.js';

// ✅ CONFIGURACIONES
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const DAYS_TTL_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;
const CONCURRENT_REQUESTS = 2;
const BATCH_SIZE = 20;
const HTTP_TIMEOUT = 7000;

// ✅ DEBUG SWITCH
const DEBUG = process.env.AVAIL_DEBUG === '1';

// ✅ CACHES
const listingAvailCache = new Map(); // { listing_avail: {data, expires} }
const daysCache = new Map();         // { days: {data, expires} }

// ✅ Inflight
const listingAvailInflight = new Map(); // key -> Promise(computed)
const daysInflight = new Map();         // key -> Promise(days[])

// Utilidades
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
 * Keys
 * ========================= */
const listingAvailKey = (id, from, to) => `listing_avail:${id}:${from}:${to}`;
const daysKey = (id, from, to, includeCheckout = false) =>
  `days:${id}:${from}:${to}:checkout:${includeCheckout ? 1 : 0}`;

/* =========================
 * Cache helpers
 * ========================= */
function cacheGet(cacheMap, key) {
  const hit = cacheMap.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cacheMap.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(cacheMap, key, data, ttl) {
  cacheMap.set(key, { data, expires: Date.now() + ttl });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* =========================
 * Deferred helper (para inflight real)
 * ========================= */
function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* =========================
 * Fechas
 * ========================= */
function ymd(input) {
  if (!input) return null;

  try {
    const s = String(input).trim();
    if (s.length < 10) return null;

    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return s.slice(0, 10);
    }

    const date = new Date(s);
    if (!isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }

    return null;
  } catch (error) {
    if (DEBUG) console.warn('[ymd] Error parsing date:', input, error);
    return null;
  }
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const date = new Date(dateStr);
  return !isNaN(date.getTime()) && dateStr.length >= 10;
}

function buildSetOfStayNights(from, to, { includeCheckout = false } = {}) {
  const out = new Set();

  if (!isValidDate(from) || !isValidDate(to)) {
    if (DEBUG) console.warn('[buildSetOfStayNights] Invalid dates:', { from, to });
    return out;
  }

  try {
    const start = new Date(from);
    const end = new Date(to);

    if (start >= end) {
      if (DEBUG) console.warn('[buildSetOfStayNights] Start date must be before end date:', { from, to });
      return out;
    }

    // noches: from .. to-1
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const dateStr = ymd(d.toISOString());
      if (dateStr) out.add(dateStr);
    }

    // opcional: incluir checkout (to) para validar CTD
    if (includeCheckout) {
      const checkoutDate = ymd(new Date(to).toISOString());
      if (checkoutDate) out.add(checkoutDate);
    }
  } catch (error) {
    if (DEBUG) console.error('[buildSetOfStayNights] Error:', error);
  }

  return out;
}

/* =========================
 * Normalización
 * ========================= */
function normalizeDay(d = {}, neededDates = null) {
  if (!d) return null;

  let date = null;
  if (d.date) date = d.date;
  else if (d.day) date = d.day;
  else if (d.startDate) date = d.startDate;
  else if (d.start) date = typeof d.start === 'string' ? d.start : null;

  date = ymd(date);
  if (!date) return null;

  if (neededDates && !neededDates.has(date)) return null;

  let price = null;
  if (Number.isFinite(d.price)) price = d.price;
  else if (Number.isFinite(+d.price)) price = +d.price;
  else if (d.price && typeof d.price === 'object' && Number.isFinite(d.price.amount)) price = d.price.amount;

  let allotment = null;
  if (Number.isFinite(d.allotment)) allotment = d.allotment;
  else if (Number.isFinite(+d.allotment)) allotment = +d.allotment;
  else if (Number.isFinite(d.availableUnits)) allotment = d.availableUnits;
  else if (Number.isFinite(d.available)) allotment = d.available;

  let status = d.status;
  if (!status) {
    const hasBlocks = d.blocks && Object.values(d.blocks).some(v => v === true);
    if (hasBlocks) status = 'unavailable';
    else if (allotment != null) status = allotment > 0 ? 'available' : 'unavailable';
    else status = 'unknown';
  }

  const cta = d.cta ?? d.checkInAllowed ?? true;
  const ctd = d.ctd ?? d.checkOutAllowed ?? true;

  let minStay = d.minNights ?? d.minStay ?? d.baseMinNights ?? 1;
  minStay = Math.max(1, parseInt(minStay) || 1);

  return {
    date,
    price: price !== null && price >= 0 ? price : null,
    allotment: allotment !== null && allotment >= 0 ? allotment : null,
    status: status || 'unknown',
    cta: Boolean(cta),
    ctd: Boolean(ctd),
    minStay
  };
}

function invertDaysToListings(daysArr = [], neededDates = null) {
  const byListing = new Map();

  for (const d of daysArr) {
    if (!d || typeof d !== 'object') continue;

    const listingId = String(d.listingId || d.id || d._id || '');
    if (!listingId) continue;

    const day = normalizeDay(d, neededDates);
    if (!day) continue;

    if (!byListing.has(listingId)) byListing.set(listingId, { listingId, days: [] });
    byListing.get(listingId).days.push(day);
  }

  return Array.from(byListing.values());
}

function normalizeCalendarResponse(data, from, to, opts = {}) {
  const out = [];
  if (!data) return out;

  const neededDates = buildSetOfStayNights(from, to, { includeCheckout: !!opts.includeCheckout });

  const processListing = (x) => {
    if (!x || typeof x !== 'object') return;

    const listingId = String(x.listingId || x.id || x._id || '');
    if (!listingId) return;

    const rawDays = x.days || x.calendar || x.availability || [];
    const days = [];

    if (Array.isArray(rawDays)) {
      for (const d of rawDays) {
        const nd = normalizeDay({ ...d, listingId }, neededDates);
        if (nd) days.push(nd);
      }
    }

    out.push({ listingId, days });
  };

  if (data?.data?.days && Array.isArray(data.data.days)) return invertDaysToListings(data.data.days, neededDates);
  if (Array.isArray(data?.days)) return invertDaysToListings(data.days, neededDates);
  if (Array.isArray(data)) { data.forEach(processListing); return out; }
  if (data?.data && Array.isArray(data.data)) { data.data.forEach(processListing); return out; }
  if (data?.data && typeof data.data === 'object') { processListing(data.data); return out; }
  if (typeof data === 'object') { processListing(data); return out; }

  return out;
}

/* =========================
 * Disponibilidad (CTA/CTD correcto)
 * ========================= */
function isRangeAvailable(days, from, to, options = {}) {
  const { checkCTA = false, checkCTD = false, requireAllDays = true } = options;

  if (!Array.isArray(days) || !isValidDate(from) || !isValidDate(to)) return false;

  const stayNights = buildSetOfStayNights(from, to, { includeCheckout: false });
  if (stayNights.size === 0) return false;

  const byDate = new Map(days.filter(d => d?.date).map(d => [d.date, d]));

  // 1) availability SOLO noches
  let availableNights = 0;
  for (const date of stayNights) {
    const day = byDate.get(date);

    if (!day) {
      if (requireAllDays) return false;
      continue;
    }

    const allotment = Number.isFinite(day.allotment) ? day.allotment : null;
    const isAvailable = allotment !== null ? allotment > 0 : day.status === 'available';
    if (!isAvailable) return false;

    if (checkCTA && date === from && !day.cta) return false;

    availableNights++;
  }

  // 2) CTD SOLO mira checkout (sin exigir availability)
  if (checkCTD) {
    const checkoutDay = byDate.get(to);
    if (!checkoutDay) return false;
    if (!checkoutDay.ctd) return false;
  }

  return requireAllDays ? (availableNights === stayNights.size) : (availableNights > 0);
}

function computeNightlyFrom(days) {
  if (!Array.isArray(days)) return null;
  const prices = days.map(d => d.price).filter(p => Number.isFinite(p) && p > 0);
  return prices.length ? Math.min(...prices) : null;
}

/* =========================
 * Fetch con backoff + timeout
 * ========================= */
async function fetchWithRetry(url, tries = MAX_RETRIES) {
  let lastErr;

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await Promise.race([
        guesty.get(url, { timeout: HTTP_TIMEOUT }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${HTTP_TIMEOUT}ms`)), HTTP_TIMEOUT + 100)
        )
      ]);

      return response;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;

      if (status >= 400 && status < 500 && status !== 429) throw err;

      if (attempt < tries) {
        const baseDelay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt - 1));
        const jitter = Math.random() * 1000;
        const delay = baseDelay + jitter;
        await sleep(delay);
      }
    }
  }

  throw lastErr;
}

async function fetchBatch(ids, from, to, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('IDs must be a non-empty array');
  if (!isValidDate(from) || !isValidDate(to)) throw new Error('Invalid date range');

  const queryParts = [];
  ids.forEach(id => {
    const cleanId = String(id).trim();
    if (cleanId) queryParts.push(`listingIds[]=${encodeURIComponent(cleanId)}`);
  });

  if (queryParts.length === 0) throw new Error('No valid IDs provided');

  queryParts.push(`startDate=${encodeURIComponent(from)}`);
  queryParts.push(`endDate=${encodeURIComponent(to)}`);

  const url = `/v1/availability-pricing/api/calendar/listings?${queryParts.join('&')}`;

  const response = await fetchWithRetry(url, MAX_RETRIES);
  return normalizeCalendarResponse(response.data, from, to, opts);
}

/* =========================
 * getAvailabilityFor (stampede REAL pre-fetch)
 * ========================= */
export async function getAvailabilityFor(ids, from, to) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  if (!isValidDate(from) || !isValidDate(to)) return [];

  const uniqueIds = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const hits = new Map();
  const inflightWait = [];
  const misses = [];

  // 1) cache / inflight / miss
  for (const id of uniqueIds) {
    const key = listingAvailKey(id, from, to);

    const cached = cacheGet(listingAvailCache, key);
    if (cached) { hits.set(id, cached); continue; }

    const inflight = listingAvailInflight.get(key);
    if (inflight) { inflightWait.push({ id, promise: inflight }); continue; }

    misses.push(id);
  }

  // 2) Registrar inflight PARA LOS MISSES (ANTES DEL FETCH)
  const missDeferred = new Map(); // id -> deferred
  for (const id of misses) {
    const key = listingAvailKey(id, from, to);
    const d = createDeferred();
    listingAvailInflight.set(key, d.promise);
    missDeferred.set(id, d);

    // cleanup inflight al terminar
    d.promise.finally(() => {
      setTimeout(() => listingAvailInflight.delete(key), 100);
    });
  }

  // 3) Fetch batches SOLO para misses (si hay)
  let listingMap = new Map();
  if (misses.length > 0) {
    const limit = pLimit(CONCURRENT_REQUESTS);
    const batches = chunk(misses, BATCH_SIZE);

    const batchResults = await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          try {
            return await fetchBatch(batch, from, to, { includeCheckout: false });
          } catch (e) {
            if (DEBUG) console.error('[getAvailabilityFor] batch failed:', e?.message);
            return [];
          }
        })
      )
    );

    listingMap = new Map();
    for (const batchResult of batchResults) {
      for (const item of batchResult) {
        if (item?.listingId) listingMap.set(item.listingId, Array.isArray(item.days) ? item.days : []);
      }
    }
  }

  // 4) Resolver deferreds (calcular + cachear)
  for (const id of misses) {
    const key = listingAvailKey(id, from, to);
    const d = missDeferred.get(id);

    try {
      const days = listingMap.get(id) || [];

      const computed = {
        available: isRangeAvailable(days, from, to, { checkCTA: false, checkCTD: false, requireAllDays: true }),
        nightlyFrom: computeNightlyFrom(days),
        daysCount: days.length,
        hasRestrictions: days.some(x => !x.cta || !x.ctd),
      };

      cacheSet(listingAvailCache, key, computed, CACHE_TTL_MS);

      if (days.length > 0) {
        cacheSet(daysCache, daysKey(id, from, to, false), days, DAYS_TTL_MS);
      }

      d.resolve(computed);
    } catch (e) {
      d.resolve({ available: false, nightlyFrom: null, daysCount: 0, hasRestrictions: false });
    }
  }

  // 5) Esperar inflight que venían de antes (en paralelo)
  const inflightResults = new Map();
  if (inflightWait.length > 0) {
    const pairs = await Promise.all(
      inflightWait.map(async ({ id, promise }) => {
        try { return [id, await promise]; }
        catch { return [id, { available: false, nightlyFrom: null, daysCount: 0, hasRestrictions: false }]; }
      })
    );
    pairs.forEach(([id, r]) => inflightResults.set(id, r));
  }

  // 6) Armar respuesta final (hits + inflight + recién resueltos)
  return uniqueIds.map(id => {
    if (hits.has(id)) return { listing_id: id, ...hits.get(id) };
    if (inflightResults.has(id)) return { listing_id: id, ...inflightResults.get(id) };

    const cached = cacheGet(listingAvailCache, listingAvailKey(id, from, to));
    if (cached) return { listing_id: id, ...cached };

    return { listing_id: id, available: false, nightlyFrom: null, daysCount: 0, hasRestrictions: false };
  });
}

/* =========================
 * getDaysForListing (cache key incluye checkout)
 * ========================= */
export async function getDaysForListing(id, from, to, options = {}) {
  if (!id || !isValidDate(from) || !isValidDate(to)) return [];

  const cleanId = String(id).trim();
  const includeCheckout = !!options.includeCheckout;
  const key = daysKey(cleanId, from, to, includeCheckout);

  const cached = cacheGet(daysCache, key);
  if (cached) return cached;

  if (daysInflight.has(key)) return daysInflight.get(key);

  const promise = (async () => {
    try {
      const batchResult = await fetchBatch([cleanId], from, to, { includeCheckout });
      const entry = Array.isArray(batchResult)
        ? batchResult.find(x => String(x.listingId) === cleanId)
        : null;

      const days = (entry && Array.isArray(entry.days)) ? entry.days : [];
      cacheSet(daysCache, key, days, DAYS_TTL_MS);
      return days;
    } catch (e) {
      return [];
    } finally {
      daysInflight.delete(key);
    }
  })();

  daysInflight.set(key, promise);
  return promise;
}

/* =========================
 * Booking estricto (CTA/CTD)
 * ========================= */
export async function checkStrictAvailability(id, from, to) {
  const days = await getDaysForListing(id, from, to, { includeCheckout: true });
  return isRangeAvailable(days, from, to, { checkCTA: true, checkCTD: true, requireAllDays: true });
}

/* =========================
 * Purge expirados
 * ========================= */
function purgeExpired(cacheMap) {
  const now = Date.now();
  for (const [k, entry] of cacheMap.entries()) {
    if (entry?.expires && now > entry.expires) cacheMap.delete(k);
  }
}

if (typeof setInterval !== 'undefined') {
  const interval = setInterval(() => {
    purgeExpired(listingAvailCache);
    purgeExpired(daysCache);
  }, 60000);
  if (interval.unref) interval.unref();
}

/* =========================
 * Utils
 * ========================= */
export function clearCache() {
  listingAvailCache.clear();
  daysCache.clear();
  listingAvailInflight.clear();
  daysInflight.clear();
}

export function getCacheStats() {
  return {
    listingAvailCache: listingAvailCache.size,
    daysCache: daysCache.size,
    listingAvailInflight: listingAvailInflight.size,
    daysInflight: daysInflight.size
  };
}

export function getPerformanceStats() {
  return {
    config: { BATCH_SIZE, CONCURRENT_REQUESTS, MAX_RETRIES, HTTP_TIMEOUT, DEBUG },
    cacheStats: getCacheStats()
  };
}

