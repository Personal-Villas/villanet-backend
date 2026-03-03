import { pool } from "../src/db.js";
import { fetchBatch, ymd } from "../src/services/availability.service.js";

// ✅ Servicio utilizado: availability.service.js (fetchBatch + ymd)

const BATCH_SIZE = 50; 
const PAUSE_MS = 3000; 

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncAvailability() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] 🚀 Iniciando sincronización...`);

  try {
    // Limpieza de fechas pasadas al inicio
    console.log("🧹 Limpiando registros de fechas pasadas...");
    const { rowCount: deleted } = await pool.query(
      "DELETE FROM listing_availability WHERE date < CURRENT_DATE",
    );
    console.log(`🗑️  ${deleted} registros pasados eliminados.`);

    // Consulta solo propiedades activas
    const { rows: listings } = await pool.query(`
      SELECT listing_id FROM listings 
      WHERE villanet_enabled = true AND is_listed = true
    `);

    const listingIds = listings.map((l) => l.listing_id);
    console.log(`📊 Total propiedades a sincronizar: ${listingIds.length}`);

    if (listingIds.length === 0) {
      console.warn("⚠️ No hay propiedades activas. Finalizando.");
      return;
    }

    // Rango: hoy hasta 180 días en el futuro
    const from = ymd(new Date());
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 180);
    const to = ymd(toDate);
    console.log(`📅 Rango de sincronización: ${from} → ${to}`);

    let totalOk = 0;
    let totalError = 0;

    // Procesamiento en batches
    for (let i = 0; i < listingIds.length; i += BATCH_SIZE) {
      const currentBatchIds = listingIds.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
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
              // UPSERT
              await upsertAvailabilityData(listingId, propertyData.days);
              // Marcar ok
              await updateSyncStatus(listingId, "ok");
              totalOk++;
            } catch (error) {
              console.error(`❌ Error persistiendo listing ${listingId}:`, error.message);
              await updateSyncStatus(listingId, "error");
              totalError++;
            }
          } else {
            // Sin datos de Guesty
            console.warn(`⚠️  Sin datos de Guesty para listing ${listingId}`);
            await updateSyncStatus(listingId, "error");
            totalError++;
          }
        }
      } catch (batchError) {
        // Fallo del batch completo
        console.error(`❌ Fallo crítico en batch ${batchNum}:`, batchError.message);
        for (const id of currentBatchIds) {
          await updateSyncStatus(id, "error");
          totalError++;
        }
      }

      // Pausa entre batches (excepto el último)
      if (i + BATCH_SIZE < listingIds.length) {
        await sleep(PAUSE_MS);
      }
    }

    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    console.log(`\n[${endTime.toISOString()}] ✅ Sincronización finalizada en ${duration}s`);
    console.log(`   ✔ OK: ${totalOk} | ✖ Error: ${totalError} | Total: ${listingIds.length}`);

  } catch (err) {
    console.error("🛑 Error fatal en el proceso de sincronización:", err);
  } finally {
    await pool.end();
  }
}

/**
 * CA3 - UPSERT masivo por propiedad.
 *
 * NOTA sobre cta/ctd: Guesty usa convención "Closed To Arrival/Departure".
 *   cta: false → check-in PERMITIDO  ✅
 *   cta: true  → check-in BLOQUEADO  ❌
 * Se almacena tal cual viene de Guesty. Al consultar filtrar con: WHERE cta = false AND ctd = false
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

  const query = `
    INSERT INTO listing_availability 
      (listing_id, date, available, price_usd, min_nights, cta, ctd, synced_at)
    VALUES ${values.join(",")}
    ON CONFLICT (listing_id, date) 
    DO UPDATE SET 
      available   = EXCLUDED.available,
      price_usd   = EXCLUDED.price_usd,
      min_nights  = EXCLUDED.min_nights,
      cta         = EXCLUDED.cta,
      ctd         = EXCLUDED.ctd,
      synced_at   = EXCLUDED.synced_at;
  `;

  return pool.query(query, params);
}

/**
 * Actualiza estado de sincronización en listings
 */
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