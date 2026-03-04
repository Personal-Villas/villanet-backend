import { pool } from "../src/db.js";
import { fetchBatch, ymd } from "../src/services/availability.service.js";
import { sendSyncErrorNotification } from "../src/services/discordNotification.service.js";

// ─── Modo de ejecución ────────────────────────────────────────────────────────
// node scripts/syncAvailability.js          → incremental (cada 4hs)
// node scripts/syncAvailability.js --full   → full resync (3 AM diario)
const IS_FULL_SYNC = process.argv.includes("--full");

const BATCH_SIZE = 20;
const PAUSE_MS   = 3000;
const RANGE_DAYS = 548; // 1 año y medio (~18 meses)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── CA3 (incremental): Lock para evitar ejecuciones simultáneas ──────────────
// El full sync NO usa lock — tiene prioridad y debe correr siempre.
async function isAlreadyRunning() {
  const { rows } = await pool.query(`
    SELECT id FROM sync_logs
    WHERE event_type = 'sync_start'
      AND created_at > NOW() - INTERVAL '60 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM sync_logs s2
        WHERE s2.event_type = 'sync_end'
          AND s2.created_at > sync_logs.created_at
      )
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows.length > 0;
}

// ─── CA4: Logging en sync_logs ────────────────────────────────────────────────
async function logSyncStart(mode) {
  const { rows } = await pool.query(`
    INSERT INTO sync_logs (event_type, message, details)
    VALUES ('sync_start', $1, $2)
    RETURNING id
  `, [
    `Sincronización ${mode} iniciada`,
    JSON.stringify({ mode }),
  ]);
  return rows[0].id;
}

async function logSyncEnd(startLogId, { mode, total, errors, duration_s, status }) {
  const ok = total - errors;
  await pool.query(`
    INSERT INTO sync_logs (event_type, message, details)
    VALUES ('sync_end', $1, $2)
  `, [
    `Sync ${mode} ${status}: ${ok} OK / ${errors} errores de ${total} propiedades en ${duration_s}s`,
    JSON.stringify({ start_log_id: startLogId, mode, total, ok, errors, duration_s, status }),
  ]);
}

async function logSyncError(message, errorDetail) {
  await pool.query(`
    INSERT INTO sync_logs (event_type, message, details)
    VALUES ('sync_error', $1, $2)
  `, [message, JSON.stringify({ error: errorDetail })]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function syncAvailability() {
  const mode      = IS_FULL_SYNC ? "full" : "incremental";
  const startTime = new Date();

  console.log(`[${startTime.toISOString()}] 🚀 Iniciando sincronización [${mode.toUpperCase()}]...`);

  // CA3 - Solo el incremental respeta el lock
  if (!IS_FULL_SYNC) {
    const running = await isAlreadyRunning();
    if (running) {
      console.warn("⚠️  Ya hay una sincronización en progreso. Abortando incremental.");
      await pool.end();
      return;
    }
  } else {
    console.log("🔄 Modo FULL: forzando resync completo sin condiciones.");
  }

  const startLogId = await logSyncStart(mode);
  let totalOk = 0;
  let totalError = 0;
  let totalListings = 0;

  try {
    // Limpieza: fechas pasadas + fechas fuera del nuevo rango
    console.log("🧹 Limpiando registros obsoletos...");
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + RANGE_DAYS);
    const to = ymd(toDate);

    const { rowCount: deletedPast } = await pool.query(
      "DELETE FROM listing_availability WHERE date < CURRENT_DATE"
    );
    console.log(`🗑️  ${deletedPast} registros pasados eliminados.`);

    // CA1 - Solo propiedades activas
    const { rows: listings } = await pool.query(`
      SELECT listing_id FROM listings
      WHERE villanet_enabled = true AND is_listed = true
    `);

    const listingIds = listings.map((l) => l.listing_id);
    totalListings = listingIds.length;
    console.log(`📊 Total propiedades a sincronizar: ${totalListings}`);

    if (totalListings === 0) {
      console.warn("⚠️ No hay propiedades activas. Finalizando.");
      await logSyncEnd(startLogId, { mode, total: 0, errors: 0, duration_s: 0, status: "ok" });
      return;
    }

    const from = ymd(new Date());
    console.log(`📅 Rango: ${from} → ${to}`);

    // Procesamiento en batches
    for (let i = 0; i < listingIds.length; i += BATCH_SIZE) {
      const currentBatchIds = listingIds.slice(i, i + BATCH_SIZE);
      const batchNum    = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(listingIds.length / BATCH_SIZE);
      console.log(`📦 Batch ${batchNum}/${totalBatches} (${currentBatchIds.length} propiedades)...`);

      try {
        const batchData = await fetchBatch(currentBatchIds, from, to);

        for (const listingId of currentBatchIds) {
          const propertyData = batchData.find(
            (d) => String(d.listingId) === String(listingId),
          );

          if (propertyData && propertyData.days.length > 0) {
            try {
              await upsertAvailabilityData(listingId, propertyData.days);
              await updateSyncStatus(listingId, "ok");
              totalOk++;
            } catch (error) {
              console.error(`❌ Error persistiendo listing ${listingId}:`, error.message);
              await updateSyncStatus(listingId, "error");
              totalError++;
            }
          } else {
            console.warn(`⚠️  Sin datos de Guesty para listing ${listingId}`);
            await updateSyncStatus(listingId, "error");
            totalError++;
          }
        }
      } catch (batchError) {
        console.error(`❌ Fallo crítico en batch ${batchNum}:`, batchError.message);
        for (const id of currentBatchIds) {
          await updateSyncStatus(id, "error");
          totalError++;
        }
      }

      if (i + BATCH_SIZE < listingIds.length) await sleep(PAUSE_MS);
    }

    const duration_s = parseFloat(((new Date() - startTime) / 1000).toFixed(1));
    const status = totalError === 0 ? "ok" : totalOk === 0 ? "failed" : "partial";

    await logSyncEnd(startLogId, { mode, total: totalListings, errors: totalError, duration_s, status });

    console.log(`\n[${new Date().toISOString()}] ✅ Sincronización [${mode}] finalizada en ${duration_s}s`);
    console.log(`   ✔ OK: ${totalOk} | ✖ Error: ${totalError} | Total: ${totalListings}`);

    // CA4 - Alerta Discord si falló todo
    if (status === "failed") {
      await sendSyncErrorNotification({ mode, status, total: totalListings, errors: totalError, duration_s, message: "Ninguna propiedad pudo sincronizarse." });
    }

  } catch (err) {
    const duration_s = parseFloat(((new Date() - startTime) / 1000).toFixed(1));
    console.error("🛑 Error fatal:", err);
    await logSyncError(err.message, err.stack);
    await logSyncEnd(startLogId, { mode, total: totalListings, errors: totalListings || 1, duration_s, status: "failed" });
    await sendSyncErrorNotification({ mode, status: "failed", total: totalListings, errors: totalListings, duration_s, message: err.message });
  } finally {
    await pool.end();
  }
}

// ─── UPSERT ───────────────────────────────────────────────────────────────────
/**
 * NOTA sobre cta/ctd: Guesty usa convención "Closed To Arrival/Departure".
 *   cta: false → check-in PERMITIDO  ✅
 *   cta: true  → check-in BLOQUEADO  ❌
 * Se almacena tal cual. Al consultar filtrar con: WHERE cta = false AND ctd = false
 */
async function upsertAvailabilityData(listingId, days) {
  const values = [];
  const params = [];
  let counter = 1;

  for (const d of days) {
    const offset = counter;
    values.push(
      `($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, NOW())`,
    );
    params.push(
      listingId,
      d.date,
      d.status === "available",
      d.price ?? null,
      d.minStay || 1,
      d.cta,
      d.ctd,
    );
    counter += 7;
  }

  return pool.query(`
    INSERT INTO listing_availability
      (listing_id, date, available, price_usd, min_nights, cta, ctd, synced_at)
    VALUES ${values.join(",")}
    ON CONFLICT (listing_id, date)
    DO UPDATE SET
      available  = EXCLUDED.available,
      price_usd  = EXCLUDED.price_usd,
      min_nights = EXCLUDED.min_nights,
      cta        = EXCLUDED.cta,
      ctd        = EXCLUDED.ctd,
      synced_at  = EXCLUDED.synced_at;
  `, params);
}

async function updateSyncStatus(listingId, status) {
  return pool.query(
    `UPDATE listings
     SET availability_synced_at = NOW(),
         availability_sync_status = $1
     WHERE listing_id = $2`,
    [status, listingId],
  );
}

syncAvailability();