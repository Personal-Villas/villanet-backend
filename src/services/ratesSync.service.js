import { guesty } from './guestyClient.js';
import { getGuestyAccessToken, forceRefreshGuestyToken } from './guestyAuth.js';
import { pool } from '../db.js';
import { cache } from '../cache.js';
import axios from 'axios';

const CACHE_TTL_SECONDS = 1800;

// exchangerate-api: base USD => rates[currency] = (1 USD = X currency)
const EXCHANGE_API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

let exchangeRatesCache = null;
let lastRatesFetch = 0;

async function getExchangeRates() {
  const now = Date.now();

  // cache 24h
  if (exchangeRatesCache && now - lastRatesFetch < 24 * 60 * 60 * 1000) {
    return exchangeRatesCache;
  }

  try {
    const { data } = await axios.get(EXCHANGE_API_URL, { timeout: 15000 });
    exchangeRatesCache = data.rates || {};
    lastRatesFetch = now;
    return exchangeRatesCache;
  } catch (err) {
    console.error('No se pudo obtener tasas de cambio → usando solo USD=1', err.message);
    // devolvemos al menos USD para no romper
    return { USD: 1 };
  }
}

/**
 * Devuelve factor para convertir amount(fromCurrency) -> USD
 * Si API es base USD: rates[from] = (1 USD = X fromCurrency)
 * Entonces 1 fromCurrency = 1/X USD => amountUSD = amountFrom / X
 */
async function getToUSDFactor(fromCurrency) {
  const cur = (fromCurrency || 'USD').toUpperCase();
  if (cur === 'USD') return { factor: 1, ok: true };

  const rates = await getExchangeRates();
  const rate = rates[cur]; // 1 USD = rate * cur

  if (!rate || typeof rate !== 'number' || rate <= 0) {
    return { factor: 1, ok: false }; // fallback 1:1
  }

  // amountUSD = amountCur / rate
  return { factor: 1 / rate, ok: true };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncAllListingRates() {
  const start = Date.now();

  await forceRefreshGuestyToken();
  const token = await getGuestyAccessToken();
  console.log(
    `[${new Date().toISOString()}] Token fresco usado en sync: ${token.substring(0, 10)}... (longitud: ${token.length})`
  );

  await pool.query(
    `INSERT INTO sync_logs (event_type, message) VALUES ('rates_sync_start', $1)`,
    [`Iniciando sync de tarifas visibles - ${new Date().toISOString()}`]
  );

  try {
    const { rows: localListings } = await pool.query(`
      SELECT listing_id
      FROM listings
      WHERE listing_id IS NOT NULL
        AND is_listed = true
        AND villanet_enabled = true
        AND (images_json IS NOT NULL AND images_json != '[]'::jsonb)
      ORDER BY updated_at DESC
    `);

    if (localListings.length === 0) {
      await pool.query(
        `INSERT INTO sync_logs (event_type, message) VALUES ('rates_sync_info', $1)`,
        ['No hay listings visibles']
      );
      console.log('No hay listings visibles');
      return;
    }

    console.log(`Sincronizando rates para ${localListings.length} listings visibles`);

    let successCount = 0;
    let errorCount = 0;
    let skipped404 = 0;
    let fxMissingCount = 0;

    for (const local of localListings) {
      const listingId = local.listing_id;

      try {
        const processed = successCount + errorCount + skipped404 + fxMissingCount;
        if (processed % 50 === 0 && processed > 0) {
          console.log(
            `Progreso: ${processed}/${localListings.length} (${successCount} OK, ${errorCount} errores, ${skipped404} 404, ${fxMissingCount} fx_missing)`
          );
        }

        const listingRes = await guesty.get(`/listings/${listingId}`);
        const data = listingRes.data;

        const prices = data.prices || {};
        const currency = (prices.currency || 'USD').toUpperCase();

        // 1) Factor currency->USD (1 paso para todo)
        const { factor: toUSD, ok: fxOk } = await getToUSDFactor(currency);

        // 2) Base price -> USD
        const rawBase = Number(prices.basePrice || prices.nightlyRate || 0);
        const basePriceUSD = round2(rawBase * toUSD);

        // 3) Fees -> USD (mismo factor)
        const fees = {};
        if (prices.cleaningFee) fees.cleaning = round2(Number(prices.cleaningFee) * toUSD);
        if (prices.extraPersonFee) fees.extra_guest = round2(Number(prices.extraPersonFee) * toUSD);
        if (prices.securityDepositFee) fees.deposit = round2(Number(prices.securityDepositFee) * toUSD);

        // 4) Seasonal calendar -> USD (mismo factor, sin await por día)
        const today = new Date().toISOString().slice(0, 10);
        const oneYearLater = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

        let seasonal = {};
        try {
          const avail = await guesty.get(
            `/availability-pricing/api/calendar/listings/${listingId}?startDate=${today}&endDate=${oneYearLater}`
          );

          const calendarData = avail.data?.data || avail.data;
          const days = calendarData?.days || [];

          for (const d of days) {
            if (d?.price && Number(d.price) > 0 && d?.date) {
              seasonal[d.date] = round2(Number(d.price) * toUSD);
            }
          }

          console.log(`📅 Precios estacionales (USD) para ${listingId}: ${Object.keys(seasonal).length} fechas`);
        } catch (availErr) {
          console.warn(`Calendar falló para ${listingId}: ${availErr.message}`);
        }

        // 5) Guardar en DB con sync_status correcto
        const syncStatus = fxOk ? 'success' : 'fx_missing';

        await pool.query(
          `
          INSERT INTO listing_rates (
            listing_id,
            base_price_usd,
            seasonal_prices,
            mandatory_fees,
            original_currency,
            last_sync_at,
            sync_status
          ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
          ON CONFLICT (listing_id) DO UPDATE SET
            base_price_usd     = EXCLUDED.base_price_usd,
            seasonal_prices    = EXCLUDED.seasonal_prices,
            mandatory_fees     = EXCLUDED.mandatory_fees,
            original_currency  = EXCLUDED.original_currency,
            last_sync_at       = NOW(),
            sync_status        = EXCLUDED.sync_status
          `,
          [listingId, basePriceUSD, seasonal, fees, currency, syncStatus]
        );

        // 6) Cache consistente con ratesRead.service.js
        cache.set(
          `rates:${listingId}`,
          {
            baseUSD: basePriceUSD,
            seasonal, // USD
            fees,     // USD
            originalCurrency: currency,
            updated: new Date(),
            source: 'guesty_sync_job',
          },
          CACHE_TTL_SECONDS
        );

        if (!fxOk) {
          fxMissingCount++;
          await pool.query(
            `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_fx_missing', $1, $2)`,
            [
              `FX rate faltante para ${listingId} (currency=${currency})`,
              { listingId, currency, note: 'Se guardó con factor 1:1 (fallback)' },
            ]
          );
        } else {
          successCount++;
        }

        // throttling (lo mantenemos como lo tenías)
        await sleep(1500);
      } catch (err) {
        if (err.response?.status === 404) {
          skipped404++;
          console.log(`Listing ${listingId} no encontrado (404) → skipping`);

          try {
            await pool.query(
              `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_skipped_404', $1, $2)`,
              [`Listing no encontrado: ${listingId}`, { status: 404 }]
            );
          } catch (logErr) {
            console.warn('No se pudo loguear skip 404:', logErr.message);
          }
          continue;
        }

        errorCount++;
        console.error(`ERROR en ${listingId}: ${err.message}`);
        if (err.response) {
          console.log(`Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
        }

        await pool.query(
          `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_error', $1, $2)`,
          [
            `Error en listing ${listingId}`,
            { error: err.message.slice(0, 500), status: err.response?.status || null },
          ]
        );
      }
    }

    await pool.query(
      `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_success', $1, $2)`,
      [
        `Sync completado: ${successCount} OK / ${fxMissingCount} fx_missing / ${errorCount} errores / ${skipped404} 404 (de ${localListings.length})`,
        { durationMs: Date.now() - start },
      ]
    );

    console.log(
      `Sync finalizado: ${successCount} OK, ${fxMissingCount} fx_missing, ${errorCount} errores, ${skipped404} 404`
    );
  } catch (globalErr) {
    const shortMsg = (globalErr.message || '').slice(0, 200);
    await pool.query(
      `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_error', $1, $2)`,
      ['global_err', { error: shortMsg, stack: globalErr.stack?.slice(0, 500) }]
    );
    console.error('Error global:', globalErr);
    throw globalErr;
  }
}

export { syncAllListingRates };