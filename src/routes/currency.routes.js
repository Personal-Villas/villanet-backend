/**
 * currency.routes.js
 * GET /api/currency/rates
 *
 * Devuelve tasas de cambio USD→EUR/CAD con cache en memoria de 60 min.
 * Si la API externa falla, devuelve los últimos rates cacheados + stale:true.
 * Si nunca hubo cache, devuelve los rates hardcodeados de emergencia.
 *
 * Registrar en server.js:
 *   import currencyRoutes from './routes/currency.routes.js';
 *   app.use('/api/currency', currencyRoutes);
 */

import { Router } from 'express';

const r = Router();

// ─── Config ────────────────────────────────────────────────────────────────────

/** Monedas soportadas (las únicas que necesita el frontend) */
const SUPPORTED = ['USD', 'EUR', 'CAD'];

/** TTL del cache en memoria: 60 minutos */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Rates de emergencia — usados si la API externa nunca respondió.
 * Fecha de referencia: April 2026.
 */
const FALLBACK_RATES = { USD: 1, EUR: 0.8677, CAD: 1.3922 };

/**
 * ExchangeRate-API free tier:
 * GET https://open.er-api.com/v6/latest/USD
 * No requiere API key para el plan gratuito.
 * Docs: https://www.exchangerate-api.com/docs/free
 */
const EXCHANGE_RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';

// ─── Cache en memoria ─────────────────────────────────────────────────────────

/**
 * @type {{ rates: Record<string,number>, lastUpdated: string } | null}
 */
let cachedRates = null;
let cacheExpiresAt = 0; // timestamp ms

// ─── Helper: fetch externo ────────────────────────────────────────────────────

/**
 * Llama a ExchangeRate-API y devuelve solo las monedas soportadas.
 * Lanza error si la respuesta no es válida.
 *
 * @returns {Promise<{ rates: Record<string,number>, lastUpdated: string }>}
 */
async function fetchFreshRates() {
  const res = await fetch(EXCHANGE_RATE_API_URL, {
    signal: AbortSignal.timeout(8000), // 8s timeout
  });

  if (!res.ok) {
    throw new Error(`ExchangeRate-API responded ${res.status}`);
  }

  const data = await res.json();

  if (data.result !== 'success' || !data.rates) {
    throw new Error('ExchangeRate-API: unexpected response shape');
  }

  const filtered = {};
  for (const code of SUPPORTED) {
    if (data.rates[code] == null) {
      throw new Error(`ExchangeRate-API: missing rate for ${code}`);
    }
    // Redondear a 4 decimales para evitar ruido de float
    filtered[code] = Math.round(data.rates[code] * 10000) / 10000;
  }

  return {
    rates: filtered,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * GET /api/currency/rates
 *
 * Response 200:
 * {
 *   "rates": { "USD": 1, "EUR": 0.91, "CAD": 1.38 },
 *   "lastUpdated": "2026-04-15T18:00:00Z",
 *   "stale": true          // solo presente si se devuelven rates cacheados viejos
 * }
 */
r.get('/rates', async (_req, res) => {
  const now = Date.now();

  // ✅ Cache vigente — respuesta rápida
  if (cachedRates && now < cacheExpiresAt) {
    return res.json(cachedRates);
  }

  // Cache expirado o primer arranque: intentar fetch externo
  try {
    const fresh = await fetchFreshRates();
    cachedRates = fresh;
    cacheExpiresAt = now + CACHE_TTL_MS;
    console.log(`💱 [currency] Rates actualizados: ${JSON.stringify(fresh.rates)}`);
    return res.json(fresh);
  } catch (err) {
    console.warn(`⚠️ [currency] fetch externo falló: ${err.message}`);

    // Si tenemos cache anterior (aunque expirado), devolverlo con stale:true
    if (cachedRates) {
      console.warn('⚠️ [currency] Devolviendo rates cacheados (stale)');
      return res.json({ ...cachedRates, stale: true });
    }

    // Sin ningún cache: usar fallback hardcodeado con stale:true
    console.warn('⚠️ [currency] Devolviendo rates de emergencia (hardcoded fallback)');
    return res.json({
      rates: FALLBACK_RATES,
      lastUpdated: new Date().toISOString(),
      stale: true,
    });
  }
});

export default r;