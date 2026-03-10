/**
 * syncFees.js
 * 
 * Sincroniza los fees estáticos de Guesty (cleaning fee, resort fee, etc.)
 * a la columna listings.fees en nuestra DB local.
 * 
 * Uso:
 *   node scripts/syncFees.js           → incremental (solo propiedades sin sync o con sync > 24hs)
 *   node scripts/syncFees.js --full    → full resync de todas las propiedades habilitadas
 * 
 * Cron sugerido: diario a las 4 AM (después del full sync de availability)
 *   0 4 * * * node scripts/syncFees.js --full
 */

import { pool } from "../src/db.js";
import { createOpenAPIQuote } from "../src/services/openApiQuote.service.js";
import { sendSyncErrorNotification } from "../src/services/discordNotification.service.js";

const IS_FULL_SYNC = process.argv.includes("--full");

const BATCH_SIZE   = 10;   // Más conservador que availability (quotes son más pesados)
const PAUSE_MS     = 4000; // 4s entre batches para no saturar Guesty
const STALE_HOURS  = 24;   // Incremental: re-sync si fees tienen más de 24hs

// Fechas de referencia para obtener un quote de Guesty sin importar disponibilidad real.
// Usamos el próximo lunes + 14 días de buffer → checkout 10 noches después.
// Lunes es menos demandado (menos CTA/CTD) y 10 noches cubre el minNights de casi todas las propiedades.
function getReferenceDates() {
  const today = new Date();
  // Próximo lunes (día 1)
  const daysUntilMonday = (1 - today.getDay() + 7) % 7 || 7;
  const checkIn = new Date(today);
  checkIn.setDate(today.getDate() + daysUntilMonday + 14); // +14 para evitar blackouts cercanos

  const checkOut = new Date(checkIn);
  checkOut.setDate(checkIn.getDate() + 10); // 10 noches

  return {
    checkIn:  ymd(checkIn),
    checkOut: ymd(checkOut),
  };
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Extraer solo los fees estáticos del quote de Guesty ─────────────────────
// NO guardamos base ni taxes — esos son date-dependent.
// Usamos normalType como identificador principal (más confiable que type).
// Base:    normalType AF  | ACCOMMODATION_FARE
// Cleaning: normalType CF | title contiene "clean"
// Tax:     normalType LT  | isTax === true
// Fees:    normalType AFE | todo lo demás (ADDITIONAL)
function extractFeesFromQuote(quoteData) {
  const invoiceItems =
    quoteData?.rates?.ratePlans?.[0]?.money?.money?.invoiceItems ||
    quoteData?.rates?.ratePlans?.[0]?.money?.invoiceItems        ||
    quoteData?.rates?.ratePlans?.[0]?.invoiceItems               ||
    quoteData?.money?.invoiceItems                               ||
    quoteData?.invoiceItems                                      ||
    quoteData?.price?.invoiceItems                               ||
    quoteData?.priceBreakdown?.invoiceItems                      ||
    [];

  if (!Array.isArray(invoiceItems) || invoiceItems.length === 0) {
    return null;
  }

  const isBase     = (it) => ["AF", "ACCOMMODATION_FARE"].includes(it.normalType);
  const isCleaning = (it) => it.normalType === "CF" || String(it.title || "").toLowerCase().includes("clean");
  const isTax      = (it) => it.isTax === true || ["LT", "TAX"].includes(it.normalType);

  // Cleaning fee
  const cleaning = invoiceItems
    .filter(isCleaning)
    .reduce((sum, it) => sum + (Number(it.amount) || 0), 0);

  // Todos los fees adicionales (AFE): CC processing, damage waiver, service fee, resort fee, etc.
  const otherFeeItems = invoiceItems.filter(
    (it) => !isBase(it) && !isCleaning(it) && !isTax(it)
  );

  const otherFees = otherFeeItems.reduce(
    (sum, it) => sum + (Number(it.amount) || 0), 0
  );

  const feeBreakdown = otherFeeItems.map((it) => ({
    title:            it.title || it.name || "Fee",
    amount:           Number(it.amount) || 0,
    type:             it.normalType || it.type || "AFE",
    secondIdentifier: it.secondIdentifier || null,  // DAMAGE_WAIVER, SERVICE, CREDIT_CARD_PROCESSING_FEE, etc.
  }));

  const currency = invoiceItems[0]?.currency || "USD";

  return {
    cleaning,
    otherFees,
    feeBreakdown,
    currency,
    synced_at: new Date().toISOString(),
  };
}

// ─── Logging ─────────────────────────────────────────────────────────────────
async function logEvent(eventType, message, details = {}) {
  await pool.query(
    `INSERT INTO sync_logs (event_type, message, details) VALUES ($1, $2, $3)`,
    [eventType, message, JSON.stringify(details)]
  );
}

// ─── Upsert fees en listings ──────────────────────────────────────────────────
async function saveFees(listingId, fees) {
  await pool.query(
    `UPDATE listings
     SET fees             = $1,
         fees_synced_at   = NOW(),
         fees_sync_status = 'ok'
     WHERE listing_id = $2`,
    [JSON.stringify(fees), listingId]
  );
}

async function markFeeError(listingId) {
  await pool.query(
    `UPDATE listings
     SET fees_synced_at   = NOW(),
         fees_sync_status = 'error'
     WHERE listing_id = $1`,
    [listingId]
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function syncFees() {
  const mode      = IS_FULL_SYNC ? "full" : "incremental";
  const startTime = new Date();

  console.log(`[${startTime.toISOString()}] 🚀 Iniciando sync de fees [${mode.toUpperCase()}]...`);

  await logEvent("sync_start", `Fees sync ${mode} iniciado`, { mode });

  let totalOk    = 0;
  let totalError = 0;
  let totalSkip  = 0;

  try {
    // Seleccionar propiedades según modo
    let query;
    if (IS_FULL_SYNC) {
      // Full: todas las propiedades habilitadas
      query = `
        SELECT listing_id, guesty_booking_domain
        FROM listings
        WHERE villanet_enabled = true AND is_listed = true
      `;
    } else {
      // Incremental: solo las que nunca se sincronizaron o tienen más de STALE_HOURS
      query = `
        SELECT listing_id, guesty_booking_domain
        FROM listings
        WHERE villanet_enabled = true
          AND is_listed = true
          AND (
            fees_synced_at IS NULL
            OR fees_synced_at < NOW() - INTERVAL '${STALE_HOURS} hours'
            OR fees_sync_status = 'error'
          )
      `;
    }

    const { rows: listings } = await pool.query(query);
    const total = listings.length;

    console.log(`📊 Propiedades a procesar: ${total}`);

    if (total === 0) {
      console.log("✅ Nada que sincronizar.");
      await logEvent("sync_end", `Fees sync ${mode} completado: 0 propiedades`, { mode, total: 0, ok: 0, errors: 0 });
      return;
    }

    const { checkIn, checkOut } = getReferenceDates();
    console.log(`📅 Fechas de referencia: ${checkIn} → ${checkOut}`);

    // Procesar en batches
    for (let i = 0; i < listings.length; i += BATCH_SIZE) {
      const batch = listings.slice(i, i + BATCH_SIZE);
      const batchNum    = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(listings.length / BATCH_SIZE);

      console.log(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} propiedades)...`);

      await Promise.allSettled(
        batch.map(async ({ listing_id, guesty_booking_domain }) => {
          try {
            const quoteData = await createOpenAPIQuote({
              listingId:    listing_id,
              checkIn,
              checkOut,
              guestsCount:  2, // mínimo estándar para obtener fees reales
              source:       "manual",
            });

            const fees = extractFeesFromQuote(quoteData);

            if (!fees) {
              console.warn(`⚠️  Sin invoiceItems para ${listing_id} — guardando fees vacíos`);
              await saveFees(listing_id, {
                cleaning:      0,
                otherFees:     0,
                feeBreakdown:  [],
                currency:      "USD",
                synced_at:     new Date().toISOString(),
              });
              totalSkip++;
              return;
            }

            await saveFees(listing_id, fees);
            console.log(`  ✔ ${listing_id} → cleaning: ${fees.cleaning}, otherFees: ${fees.otherFees}, ${fees.feeBreakdown.length} fees`);
            totalOk++;

          } catch (err) {
            console.error(`  ❌ ${listing_id}: ${err.message}`);
            await markFeeError(listing_id);
            totalError++;
          }
        })
      );

      if (i + BATCH_SIZE < listings.length) await sleep(PAUSE_MS);
    }

    const duration_s  = parseFloat(((new Date() - startTime) / 1000).toFixed(1));
    const status      = totalError === 0 ? "ok" : totalOk === 0 ? "failed" : "partial";

    await logEvent("sync_end", `Fees sync ${mode} ${status}: ${totalOk} OK / ${totalError} errores / ${totalSkip} sin fees en ${duration_s}s`, {
      mode, total, ok: totalOk, errors: totalError, skipped: totalSkip, duration_s, status,
    });

    console.log(`\n[${new Date().toISOString()}] ✅ Sync fees [${mode}] finalizado en ${duration_s}s`);
    console.log(`   ✔ OK: ${totalOk} | ✖ Error: ${totalError} | ⚠ Sin fees: ${totalSkip} | Total: ${total}`);

    if (status === "failed") {
      await sendSyncErrorNotification({
        mode, status, total, errors: totalError, duration_s,
        message: "syncFees: Ninguna propiedad pudo sincronizarse.",
      });
    }

  } catch (err) {
    const duration_s = parseFloat(((new Date() - startTime) / 1000).toFixed(1));
    console.error("🛑 Error fatal en syncFees:", err);
    await logEvent("sync_error", err.message, { error: err.stack });
    await sendSyncErrorNotification({
      mode, status: "failed", total: 0, errors: 1, duration_s,
      message: `syncFees fatal: ${err.message}`,
    });
  } finally {
    await pool.end();
  }
}

syncFees();