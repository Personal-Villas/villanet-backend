/**
 * validateAvailability.js
 * Compara datos en DB vs respuesta live de Guesty para N propiedades al azar.
 * Uso: node scripts/validateAvailability.js [cantidad]
 * Ejemplo: node scripts/validateAvailability.js 10
 */

import { pool } from "../src/db.js";
import { fetchBatch, ymd } from "../src/services/availability.service.js";

const SAMPLE_SIZE = parseInt(process.argv[2]) || 5;
const CHECK_DAYS = 14; // Comparamos los próximos 14 días

async function validateAvailability() {
  console.log(`\n🔍 Validando ${SAMPLE_SIZE} propiedades al azar contra Guesty live...\n`);

  try {
    // 1) N propiedades al azar con sync OK
    const { rows: sample } = await pool.query(`
      SELECT listing_id 
      FROM listings
      WHERE villanet_enabled = true 
        AND is_listed = true
        AND availability_sync_status = 'ok'
      ORDER BY RANDOM()
      LIMIT $1
    `, [SAMPLE_SIZE]);

    if (sample.length === 0) {
      console.error("❌ No hay propiedades con sync_status = ok.");
      return;
    }

    const listingIds = sample.map(r => r.listing_id);
    const from = ymd(new Date());
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + CHECK_DAYS);
    const to = ymd(toDate);

    console.log(`📅 Rango: ${from} → ${to}`);
    console.log(`📋 Listings: ${listingIds.join(", ")}\n`);

    // 2) Fetch live desde Guesty
    console.log("⏳ Consultando Guesty en vivo...");
    const liveData = await fetchBatch(listingIds, from, to);
    const liveMap = new Map(liveData.map(d => [String(d.listingId), d.days]));

    // 3) Fetch desde DB
    const { rows: dbRows } = await pool.query(`
      SELECT listing_id, date, available, price_usd, min_nights, cta, ctd
      FROM listing_availability
      WHERE listing_id = ANY($1)
        AND date >= $2 AND date <= $3
      ORDER BY listing_id, date
    `, [listingIds, from, to]);

    const dbMap = new Map();
    for (const row of dbRows) {
      const id = String(row.listing_id);
      if (!dbMap.has(id)) dbMap.set(id, new Map());
      dbMap.get(id).set(row.date.toISOString().slice(0, 10), row);
    }

    // 4) Comparar
    let totalDays = 0, matchDays = 0, mismatchDays = 0;
    const report = [];

    for (const listingId of listingIds) {
      const id = String(listingId);
      const liveDays = liveMap.get(id) || [];
      const dbDays = dbMap.get(id) || new Map();
      const listingReport = { listingId: id, ok: [], mismatches: [], missing: [] };

      for (const liveDay of liveDays) {
        const date = liveDay.date;
        const dbDay = dbDays.get(date);
        totalDays++;

        if (!dbDay) {
          listingReport.missing.push(date);
          mismatchDays++;
          continue;
        }

        const diffs = [];

        const liveAvail = liveDay.status === "available";
        if (Boolean(dbDay.available) !== liveAvail)
          diffs.push(`available: DB=${dbDay.available} | Live=${liveAvail}`);

        const livePrice = liveDay.price ?? null;
        const dbPrice = dbDay.price_usd !== null ? Number(dbDay.price_usd) : null;
        if (livePrice !== null && dbPrice !== null && Math.abs(livePrice - dbPrice) > 1)
          diffs.push(`price: DB=${dbPrice} | Live=${livePrice}`);

        const liveMin = liveDay.minStay || 1;
        const dbMin = Number(dbDay.min_nights) || 1;
        if (liveMin !== dbMin)
          diffs.push(`min_nights: DB=${dbMin} | Live=${liveMin}`);

        if (Boolean(dbDay.cta) !== Boolean(liveDay.cta))
          diffs.push(`cta: DB=${dbDay.cta} | Live=${liveDay.cta}`);

        if (Boolean(dbDay.ctd) !== Boolean(liveDay.ctd))
          diffs.push(`ctd: DB=${dbDay.ctd} | Live=${liveDay.ctd}`);

        if (diffs.length > 0) {
          listingReport.mismatches.push({ date, diffs });
          mismatchDays++;
        } else {
          listingReport.ok.push(date);
          matchDays++;
        }
      }

      report.push(listingReport);
    }

    // 5) Resultados
    console.log("\n═══════════════════════════════════════════════");
    console.log("                   RESULTADOS                  ");
    console.log("═══════════════════════════════════════════════\n");

    for (const r of report) {
      const total = r.ok.length + r.mismatches.length + r.missing.length;
      const pct = total > 0 ? ((r.ok.length / total) * 100).toFixed(1) : "0.0";
      const icon = r.mismatches.length === 0 && r.missing.length === 0 ? "✅" : "⚠️ ";
      console.log(`${icon} ${r.listingId}  →  ${r.ok.length}/${total} días OK (${pct}%)`);

      if (r.missing.length > 0)
        console.log(`   ❌ Faltantes en DB: ${r.missing.slice(0, 5).join(", ")}${r.missing.length > 5 ? ` (+${r.missing.length - 5} más)` : ""}`);

      for (const m of r.mismatches.slice(0, 3))
        console.log(`   ⚡ ${m.date}: ${m.diffs.join(" | ")}`);

      if (r.mismatches.length > 3)
        console.log(`   ... y ${r.mismatches.length - 3} discrepancias más`);
    }

    const globalPct = totalDays > 0 ? ((matchDays / totalDays) * 100).toFixed(1) : "0.0";
    console.log("\n───────────────────────────────────────────────");
    console.log(`📊 RESUMEN: ${matchDays}/${totalDays} días coinciden (${globalPct}%)`);
    console.log(`   ✔ Match: ${matchDays}  |  ✖ Diff: ${mismatchDays}`);

    if (parseFloat(globalPct) >= 99)       console.log("🎉 Sincronización validada correctamente.\n");
    else if (parseFloat(globalPct) >= 95)  console.log("🟡 Discrepancias menores — revisar precios/minNights.\n");
    else                                    console.log("🔴 Discrepancias significativas — revisar el sync.\n");

  } catch (err) {
    console.error("🛑 Error en validación:", err);
  } finally {
    await pool.end();
  }
}

validateAvailability();