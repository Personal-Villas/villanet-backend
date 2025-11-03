import pLimit from 'p-limit';
import { guesty } from './guestyClient.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const DAYS_TTL_MS = 10 * 60 * 1000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
const CONCURRENT_REQUESTS = 3;
const BATCH_SIZE = 35;

// Caches
const cache = new Map();
const daysCache = new Map();
const inflight = new Map();
const daysInflight = new Map();

// Utilidades
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Generadores de keys para cache
const keyOf = (ids, from, to) => `avail:${[...ids].sort().join(',')}:${from}:${to}`;
const daysKey = (id, from, to) => `days:${id}:${from}:${to}`;

/* =========================
 * Gestión de Cache
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
 * Normalización de días - MEJORADA
 * ========================= */
function normalizeDay(d = {}) {
  if (!d) return null;

  // Fecha - más robusto
  let date = null;
  if (d.date) date = d.date;
  else if (d.day) date = d.day;
  else if (d.startDate) date = d.startDate;
  else if (d.start) date = typeof d.start === 'string' ? d.start : null;
  
  date = ymd(date);
  if (!date) return null;

  // Precio - manejo mejorado de valores inválidos
  let price = null;
  if (Number.isFinite(d.price)) {
    price = d.price;
  } else if (Number.isFinite(+d.price)) {
    price = +d.price;
  } else if (d.price && typeof d.price === 'object' && Number.isFinite(d.price.amount)) {
    price = d.price.amount;
  }

  // Disponibilidad/Allotment - lógica mejorada
  let allotment = null;
  if (Number.isFinite(d.allotment)) {
    allotment = d.allotment;
  } else if (Number.isFinite(+d.allotment)) {
    allotment = +d.allotment;
  } else if (Number.isFinite(d.availableUnits)) {
    allotment = d.availableUnits;
  } else if (Number.isFinite(d.available)) {
    allotment = d.available;
  }

  // Status - lógica más robusta
  let status = d.status;
  if (!status) {
    const hasBlocks = d.blocks && Object.values(d.blocks).some(v => v === true);
    if (hasBlocks) {
      status = 'unavailable';
    } else if (allotment != null) {
      status = allotment > 0 ? 'available' : 'unavailable';
    } else {
      status = 'unknown';
    }
  }

  // Check-in/out permitidos - con valores por defecto seguros
  const cta = d.cta ?? d.checkInAllowed ?? true;
  const ctd = d.ctd ?? d.checkOutAllowed ?? true;

  // Min nights - con validación
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

/* =========================
 * Helpers de fecha/conversión - MEJORADOS
 * ========================= */
function ymd(input) {
  if (!input) return null;
  
  try {
    const s = String(input).trim();
    if (s.length < 10) return null;
    
    // Para fechas ISO (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return s.slice(0, 10);
    }
    
    // Para otros formatos, intentar parsear con Date
    const date = new Date(s);
    if (!isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
    
    return null;
  } catch (error) {
    console.warn('[ymd] Error parsing date:', input, error);
    return null;
  }
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const date = new Date(dateStr);
  return !isNaN(date.getTime()) && dateStr.length >= 10;
}

function buildSetOfStayNights(from, to) {
  const out = new Set();
  
  if (!isValidDate(from) || !isValidDate(to)) {
    console.warn('[buildSetOfStayNights] Invalid dates:', { from, to });
    return out;
  }

  try {
    const start = new Date(from);
    const end = new Date(to);
    
    if (start >= end) {
      console.warn('[buildSetOfStayNights] Start date must be before end date:', { from, to });
      return out;
    }

    // 🔥 IMPORTANTE: No incluir el día de check-out (solo noches de estadía)
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const dateStr = ymd(d.toISOString());
      if (dateStr) out.add(dateStr);
    }
  } catch (error) {
    console.error('[buildSetOfStayNights] Error:', error);
  }
  
  console.log(`[buildSetOfStayNights DEBUG] From ${from} to ${to} = ${out.size} nights:`, Array.from(out).slice(0, 5));
  
  return out;
}

// Cuando la API viene "por días", invertimos a "por listing"
function invertDaysToListings(daysArr = []) {
  const byListing = new Map();

  for (const d of daysArr) {
    if (!d || typeof d !== 'object') continue;

    const listingId = String(d.listingId || d.id || d._id || '');
    if (!listingId) continue;

    const day = normalizeDay(d);
    if (!day) continue;

    if (!byListing.has(listingId)) {
      byListing.set(listingId, { listingId, days: [] });
    }
    byListing.get(listingId).days.push(day);
  }
  
  return Array.from(byListing.values());
}

/* =========================
 * Normalización de respuestas - MEJORADA
 * ========================= */
function normalizeCalendarResponse(data) {
  const out = [];

  if (!data) {
    console.warn('[normalizeCalendarResponse] No data provided');
    return out;
  }

  // Helper para procesar un listing
  const processListing = (x) => {
    if (!x || typeof x !== 'object') return;

    const listingId = String(x.listingId || x.id || x._id || '');
    if (!listingId) return;

    const rawDays = x.days || x.calendar || x.availability || [];
    const days = Array.isArray(rawDays) 
      ? rawDays.map(d => normalizeDay({ ...d, listingId })).filter(Boolean)
      : [];

    out.push({ listingId, days });
  };

  // Caso A: formato por días dentro de data.days
  if (data?.data?.days && Array.isArray(data.data.days)) {
    console.log('[normalizeCalendarResponse] Format: data.days array');
    return invertDaysToListings(data.data.days);
  }

  // Caso B: formato por días en raíz: { days: [...] }
  if (Array.isArray(data?.days)) {
    console.log('[normalizeCalendarResponse] Format: root days array');
    return invertDaysToListings(data.days);
  }

  // Caso C: array de listings
  if (Array.isArray(data)) {
    console.log('[normalizeCalendarResponse] Format: array of listings');
    data.forEach(processListing);
    return out;
  }

  // Caso D: data.data array de listings
  if (data?.data && Array.isArray(data.data)) {
    console.log('[normalizeCalendarResponse] Format: data array');
    data.data.forEach(processListing);
    return out;
  }

  // Caso E: data.data objeto listing único
  if (data?.data && typeof data.data === 'object') {
    console.log('[normalizeCalendarResponse] Format: data object');
    processListing(data.data);
    return out;
  }

  // Caso F: raíz objeto listing único
  if (typeof data === 'object') {
    console.log('[normalizeCalendarResponse] Format: root object');
    processListing(data);
    return out;
  }

  console.warn('[normalizeCalendarResponse] Unknown data format:', typeof data);
  return out;
}

/* =========================
 * Lógica de disponibilidad - MEJORADA CON CTA/CTD OPCIONAL
 * ========================= */
function isRangeAvailable(days, from, to, options = {}) {
  // 🔥 OPCIONES CONFIGURABLES: Por defecto NO verificar CTA/CTD
  const {
    checkCTA = false,  // No verificar check-in allowed por defecto
    checkCTD = false,  // No verificar check-out allowed por defecto
    requireAllDays = true
  } = options;

  if (!Array.isArray(days) || !isValidDate(from) || !isValidDate(to)) {
    console.log(`[isRangeAvailable DEBUG] ❌ Invalid input: days=${days?.length}, from=${from}, to=${to}`);
    return false;
  }

  const needed = buildSetOfStayNights(from, to);
  if (needed.size === 0) {
    console.log(`[isRangeAvailable DEBUG] ❌ No nights needed`);
    return false;
  }

  // Indexar por fecha
  const byDate = new Map();
  for (const d of days) {
    if (d && d.date) {
      byDate.set(d.date, d);
    }
  }

  // 🐛 DEBUG: Ver qué días tenemos
  if (days.length > 0) {
    const firstDay = days[0];
    console.log(`[isRangeAvailable DEBUG] Sample day:`, {
      date: firstDay.date,
      price: firstDay.price,
      allotment: firstDay.allotment,
      status: firstDay.status,
      cta: firstDay.cta,
      ctd: firstDay.ctd
    });
    console.log(`[isRangeAvailable DEBUG] Options: checkCTA=${checkCTA}, checkCTD=${checkCTD}`);
    console.log(`[isRangeAvailable DEBUG] Total days: ${days.length}, Needed: ${needed.size}`);
  }

  // Verificar cada noche necesaria
  let availableDays = 0;
  for (const date of needed) {
    const day = byDate.get(date);
    
    if (!day) {
      if (requireAllDays) {
        console.log(`[isRangeAvailable] ❌ Missing date: ${date}`);
        return false;
      }
      continue;
    }

    // Verificar disponibilidad básica
    const allotment = Number.isFinite(day.allotment) ? day.allotment : null;
    const isAvailable = allotment !== null 
      ? allotment > 0 
      : day.status === 'available';

    if (!isAvailable) {
      console.log(`[isRangeAvailable] ❌ Unavailable date: ${date}, allotment: ${allotment}, status: ${day.status}`);
      return false;
    }

    // ✅ OPCIONAL: Solo verificar CTA/CTD si está habilitado explícitamente
    if (checkCTA && date === from && !day.cta) {
      console.log(`[isRangeAvailable] ❌ Check-in restricted on ${date}`);
      return false;
    }
    if (checkCTD && date === to && !day.ctd) {
      console.log(`[isRangeAvailable] ❌ Check-out restricted on ${date}`);
      return false;
    }

    availableDays++;
  }

  const isAvail = requireAllDays ? availableDays === needed.size : availableDays > 0;
  console.log(`[isRangeAvailable] ✅ ${availableDays}/${needed.size} days available = ${isAvail}`);
  return isAvail;
}

function computeNightlyFrom(days) {
  if (!Array.isArray(days)) return null;
  
  const prices = days
    .map(d => d.price)
    .filter(price => Number.isFinite(price) && price > 0);
  
  return prices.length > 0 ? Math.min(...prices) : null;
}

/* =========================
 * Fetch con backoff exponencial - MEJORADO
 * ========================= */
async function fetchWithRetry(url, tries = MAX_RETRIES) {
  let lastErr;

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await guesty.get(url);
      console.log(`[fetchWithRetry] ✅ Attempt ${attempt} successful`);
      return response;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;

      // No reintentar para errores 4xx (excepto 429)
      if (status >= 400 && status < 500 && status !== 429) {
        console.warn(`[fetchWithRetry] Client error ${status}, not retrying`);
        throw err;
      }

      // Calcular delay con backoff exponencial + jitter
      if (attempt < tries) {
        const baseDelay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt - 1));
        const jitter = Math.random() * 1000;
        const delay = baseDelay + jitter;

        console.warn(`[fetchWithRetry] Attempt ${attempt} failed (${status}). Waiting ${Math.round(delay)}ms...`);
        await sleep(delay);
      }
    }
  }

  console.error(`[fetchWithRetry] ❌ All ${tries} attempts failed`);
  throw lastErr;
}

/* =========================
 * SINGLE BATCH - MEJORADO CON DEBUG
 * ========================= */
async function fetchBatch(ids, from, to) {
  const batchId = Math.random().toString(36).substring(2, 8);

  try {
    console.log(`[fetchBatch:${batchId}] Requesting ${ids.length} listings from ${from} to ${to}`);

    // Validación de parámetros
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('IDs must be a non-empty array');
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      throw new Error('Invalid date range');
    }

    // Construir query string
    const queryParts = [];
    ids.forEach(id => {
      const cleanId = String(id).trim();
      if (cleanId) {
        queryParts.push(`listingIds[]=${encodeURIComponent(cleanId)}`);
      }
    });

    if (queryParts.length === 0) {
      throw new Error('No valid IDs provided');
    }

    queryParts.push(`startDate=${encodeURIComponent(from)}`);
    queryParts.push(`endDate=${encodeURIComponent(to)}`);

    const queryString = queryParts.join('&');
    const url = `/v1/availability-pricing/api/calendar/listings?${queryString}`;

    console.log(`[fetchBatch:${batchId}] Fetching ${ids.length} listings`);

    const response = await fetchWithRetry(url, MAX_RETRIES);

    // 🐛 DEBUG TEMPORAL: Ver respuesta raw de Guesty
    if (ids.length <= 3) {
      console.log(`[fetchBatch:${batchId} DEBUG] Raw response sample:`, 
        JSON.stringify(response.data, null, 2).slice(0, 1000)
      );
    }

    const result = normalizeCalendarResponse(response.data);

    console.log(`[fetchBatch:${batchId}] ✅ Success: ${result.length} listings returned`);

    if (result.length === 0) {
      console.warn(`[fetchBatch:${batchId}] ⚠️ Response returned 0 listings`);
    }

    return result;
  } catch (err) {
    const status = err?.response?.status;

    if (err.message?.includes('OAuth bloqueado')) {
      console.error(`[fetchBatch:${batchId}] OAuth bloqueado:`, err.message);
    }

    console.error(`[fetchBatch:${batchId}] ❌ Failed:`, {
      status,
      message: err?.message,
      data: err?.response?.data
    });

    // Para errores de batch, retornar array vacío en lugar de fallar completamente
    if (status >= 400 && status < 500) {
      console.warn(`[fetchBatch:${batchId}] Returning empty result for failed batch`);
      return [];
    }

    throw err;
  }
}

/* =========================
 * BATCH SUMMARY (listado) - MEJORADO CON CTA/CTD OPCIONAL
 * ========================= */
export async function getAvailabilityFor(ids, from, to) {
  if (!Array.isArray(ids) || ids.length === 0) {
    console.warn('[getAvailabilityFor] Empty or invalid IDs array');
    return [];
  }

  if (!isValidDate(from) || !isValidDate(to)) {
    console.warn('[getAvailabilityFor] Invalid date range:', { from, to });
    return [];
  }

  const key = keyOf(ids, from, to);
  const cached = cacheGet(cache, key);
  if (cached) {
    console.log(`[getAvailabilityFor] ✅ Cache hit (${ids.length} listings)`);
    return cached;
  }

  if (inflight.has(key)) {
    console.log(`[getAvailabilityFor] ⏳ Using inflight request (${ids.length} listings)`);
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      // Limpiar IDs duplicados e inválidos
      const uniqueIds = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
      
      if (uniqueIds.length === 0) {
        console.warn('[getAvailabilityFor] No valid IDs after cleaning');
        return [];
      }

      console.log(`[getAvailabilityFor] Processing ${uniqueIds.length} unique listings from ${from} to ${to}`);

      const limit = pLimit(CONCURRENT_REQUESTS);
      const batches = chunk(uniqueIds, BATCH_SIZE);

      console.log(`[getAvailabilityFor] Created ${batches.length} batches`);

      const batchPromises = batches.map((batch, index) => 
        limit(async () => {
          console.log(`[getAvailabilityFor] Processing batch ${index + 1}/${batches.length} (${batch.length} listings)`);
          try {
            return await fetchBatch(batch, from, to);
          } catch (error) {
            console.error(`[getAvailabilityFor] Batch ${index + 1} failed:`, error.message);
            return []; // Retornar array vacío para batches fallidos
          }
        })
      );

      const batchResults = await Promise.all(batchPromises);

      // Consolidar resultados
      const listingMap = new Map();
      for (const batchResult of batchResults) {
        for (const item of batchResult) {
          if (item && item.listingId) {
            listingMap.set(item.listingId, Array.isArray(item.days) ? item.days : []);
          }
        }
      }

      // Construir respuesta final con CTA/CTD DESHABILITADO
      const result = uniqueIds.map(id => {
        const days = listingMap.get(id) || [];
        
        // 🔥 NO verificar CTA/CTD en búsqueda de listado
        const available = isRangeAvailable(days, from, to, {
          checkCTA: false,  // Deshabilitado para búsqueda
          checkCTD: false,  // Deshabilitado para búsqueda
          requireAllDays: true
        });
        
        // 🐛 DEBUG: Log primeras 3 propiedades
        if (uniqueIds.indexOf(id) < 3) {
          console.log(`[getAvailabilityFor DEBUG] Listing ${id}:`, {
            daysCount: days.length,
            available,
            sampleDates: days.slice(0, 3).map(d => ({ 
              date: d.date, 
              status: d.status, 
              allotment: d.allotment,
              price: d.price,
              cta: d.cta,    // Para debug
              ctd: d.ctd     // Para debug
            }))
          });
        }
        
        // Agregar info adicional para el frontend sobre restricciones
        const hasRestrictions = days.some(d => !d.cta || !d.ctd);
        
        return {
          listing_id: id,
          available,
          nightlyFrom: computeNightlyFrom(days),
          daysCount: days.length,
          hasRestrictions  // Info útil para el frontend
        };
      });

      // Estadísticas de disponibilidad
      const availableCount = result.filter(r => r.available).length;
      const restrictedCount = result.filter(r => r.hasRestrictions).length;
      console.log(`[getAvailabilityFor] 📊 Availability stats: ${availableCount}/${result.length} available`);
      console.log(`[getAvailabilityFor] 📊 Restrictions stats: ${restrictedCount}/${result.length} have CTA/CTD restrictions`);

      cacheSet(cache, key, result, CACHE_TTL_MS);
      console.log(`[getAvailabilityFor] ✅ Completed processing ${result.length} listings`);

      return result;
    } catch (error) {
      console.error('[getAvailabilityFor] ❌ Critical error:', error);
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/* =========================
 * DAYS cache para detalle - MEJORADO CON OPCIONES FLEXIBLES
 * ========================= */
export async function getDaysForListing(id, from, to, options = {}) {
  if (!id || !isValidDate(from) || !isValidDate(to)) {
    console.warn('[getDaysForListing] Invalid parameters:', { id, from, to });
    return [];
  }

  const cleanId = String(id).trim();
  const key = daysKey(cleanId, from, to);
  
  const cached = cacheGet(daysCache, key);
  if (cached) {
    console.log(`[getDaysForListing] ✅ Cache hit for ${cleanId}`);
    return cached;
  }

  if (daysInflight.has(key)) {
    console.log(`[getDaysForListing] ⏳ Using inflight request for ${cleanId}`);
    return daysInflight.get(key);
  }

  const promise = (async () => {
    try {
      console.log(`[getDaysForListing] Fetching days for ${cleanId} from ${from} to ${to}`);
      
      const batchResult = await fetchBatch([cleanId], from, to);
      const entry = Array.isArray(batchResult) 
        ? batchResult.find(x => String(x.listingId) === cleanId)
        : null;
      
      const days = (entry && Array.isArray(entry.days)) ? entry.days : [];

      // DEBUG para días individuales
      if (days.length > 0) {
        console.log(`[getDaysForListing DEBUG] First 3 days for ${cleanId}:`, 
          days.slice(0, 3).map(d => ({
            date: d.date,
            status: d.status,
            allotment: d.allotment,
            price: d.price,
            cta: d.cta,
            ctd: d.ctd
          }))
        );
      }

      cacheSet(daysCache, key, days, DAYS_TTL_MS);
      console.log(`[getDaysForListing] ✅ Fetched ${days.length} days for ${cleanId}`);

      return days;
    } catch (error) {
      console.error(`[getDaysForListing] ❌ Failed to fetch days for ${cleanId}:`, error);
      return []; // Retornar array vacío en caso de error
    } finally {
      daysInflight.delete(key);
    }
  })();

  daysInflight.set(key, promise);
  return promise;
}

/* =========================
 * Función específica para verificación estricta (para booking)
 * ========================= */
export async function checkStrictAvailability(id, from, to) {
  const days = await getDaysForListing(id, from, to);
  
  // Para booking final, SÍ verificar CTA/CTD
  return isRangeAvailable(days, from, to, {
    checkCTA: true,   // Habilitado para booking
    checkCTD: true,   // Habilitado para booking
    requireAllDays: true
  });
}

/* =========================
 * Utilidades adicionales
 * ========================= */

// Limpiar caches manualmente
export function clearCache() {
  cache.clear();
  daysCache.clear();
  console.log('[clearCache] All caches cleared');
}

// Estadísticas de cache
export function getCacheStats() {
  return {
    availability: {
      size: cache.size,
      keys: Array.from(cache.keys())
    },
    days: {
      size: daysCache.size,
      keys: Array.from(daysCache.keys())
    },
    inflight: {
      availability: inflight.size,
      days: daysInflight.size
    }
  };
}