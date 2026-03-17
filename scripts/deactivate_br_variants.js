/**
 * deactivate_br_variants.js
 *
 * Identifica grupos de propiedades que son variantes de la misma villa
 * (ej: "Villa Amber 2BR", "Villa Amber 3BR", "Villa Amber 4BR") y desactiva
 * todas las de menor capacidad, dejando activa solo la de mayor bedrooms.
 *
 * Uso:
 *   node deactivate_br_variants.js            → DRY RUN (solo imprime, no modifica)
 *   node deactivate_br_variants.js --execute  → Ejecuta los UPDATEs en DB
 *
 * Seguridad:
 *   - Solo actúa sobre registros con villanet_enabled = true
 *   - Imprime reporte completo antes de ejecutar
 *   - Requiere flag --execute explícito para modificar datos
 */

import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host:     process.env.PGHOST,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port:     parseInt(process.env.PGPORT || '5432'),
  ssl:      { rejectUnauthorized: false }, // necesario para RDS
});

// ─── Regex para detectar sufijo de habitaciones ───────────────────────────────
// Soporta: "3BR", "3 BR", "4 BR", "10BR"
// Con o sin espacio, al final del nombre o seguido de separador (, - at)
const BR_SUFFIX_RE = /\s+(\d+)\s*BR\b/i;

/**
 * Extrae el nombre base quitando el sufijo BR.
 * "Villa Amber 4BR"         → "Villa Amber"
 * "Casa Tabachin - 6 BR"   → "Casa Tabachin -"   (trailing dash OK; se normaliza luego)
 * "Twin Palms 7BR, TC"     → "Twin Palms, TC"
 */
function getBaseName(name) {
  return name.replace(BR_SUFFIX_RE, "").trim();
}

/**
 * Normaliza para comparación: minúsculas, colapsa espacios, quita puntuación final.
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s\-,]+$/, "") // trailing separators
    .trim();
}

/**
 * Extrae el número BR del nombre (para logging / referencia).
 * Devuelve null si no encuentra.
 */
function extractBRNumber(name) {
  const m = BR_SUFFIX_RE.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Escribe el reporte acumulado en scripts/docs/
 * Crea el directorio si no existe.
 */
function writeReport(dir, filePath, lines) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
    console.log(`\n📄 Reporte guardado en: ${filePath}\n`);
  } catch (err) {
    console.warn(`⚠️  No se pudo guardar el reporte: ${err.message}`);
  }
}

async function main() {
  const isDryRun = !process.argv.includes("--execute");

  // ── Reporte: acumula líneas para escribir archivo al final ────────────────
  const reportLines = [];
  const log = (msg = "") => {
    console.log(msg);
    // Quitar emojis para el archivo de texto plano (legible en cualquier editor)
    reportLines.push(msg.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|═|─/gu, (m) =>
      m === "═" ? "=" : m === "─" ? "-" : ""
    ));
  };

  const REPORT_DIR  = path.resolve("scripts/docs");
  const dateStr     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const modeTag     = isDryRun ? "dry-run" : "execute";
  const REPORT_PATH = path.join(REPORT_DIR, `br_variants_report_${dateStr}_${modeTag}.txt`);

  log("═══════════════════════════════════════════════════════════");
  log(" VillaNet — Deactivate BR Variants Script");
  log(` Mode: ${isDryRun ? "🔍 DRY RUN (sin cambios en DB)" : "⚡ EXECUTE (modificando DB)"}`);
  log(`  Reporte: ${REPORT_PATH}`);
  log("═══════════════════════════════════════════════════════════\n");

  // ── 1. Cargar todos los registros activos con sufijo BR ───────────────────
  const { rows } = await pool.query(`
    SELECT
      listing_id,
      name,
      bedrooms,
      is_listed,
      villanet_enabled,
      villanet_property_manager_name,
      villanet_destination_tag,
      city
    FROM public.listings
    WHERE villanet_enabled = true
      AND name ILIKE '%BR%'
    ORDER BY name
  `);

  log(`📋 Registros con sufijo BR encontrados (villanet_enabled=true): ${rows.length}\n`);

  // Filtrar en JS: solo los que realmente tienen el patrón NNBRsuffix
  // (ILIKE '%BR%' puede traer falsos positivos como "Barbados", "obre", etc.)
  const brRows = rows.filter(r => BR_SUFFIX_RE.test(r.name));
  log(`📋 Tras filtro JS (patrón \\d+BR): ${brRows.length}\n`);

  // ── 2. Agrupar por (nombre_base_normalizado + PMC) ───────────────────────
  // La clave de agrupación usa PMC para evitar mezclar villas de distintos managers
  // con nombres parecidos (ej: "Villa Sol" de PMC-A vs PMC-B).
  const groups = new Map();

  for (const row of brRows) {
    const base = normalize(getBaseName(row.name));
    const pmc  = (row.villanet_property_manager_name || "").trim().toLowerCase();
    const key  = `${pmc}::${base}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // ── 3. Filtrar grupos con más de 1 variante ───────────────────────────────
  const multiGroups = [...groups.entries()].filter(([, v]) => v.length > 1);

  log(`🏘  Grupos con múltiples variantes BR: ${multiGroups.length}`);

  // ── 4. Para cada grupo, determinar ganadora y perdedoras ─────────────────
  const toDisable   = []; // { listing_id, name, bedrooms, reason }
  const winners     = []; // { listing_id, name, bedrooms, groupKey }
  const tieGroups   = []; // grupos donde el campo bedrooms tiene empates

  for (const [key, variants] of multiGroups) {
    // Ordenar por bedrooms DESC, luego por nombre BR number DESC como desempate secundario
    // (útil para casos como "Twin Palms 5BR" que tiene bedrooms=7 igual que "Twin Palms 7BR")
    const sorted = [...variants].sort((a, b) => {
      const bedDiff = (b.bedrooms ?? 0) - (a.bedrooms ?? 0);
      if (bedDiff !== 0) return bedDiff;

      // Desempate: usar el número extraído del nombre (el más alto es la versión "real")
      const brA = extractBRNumber(a.name) ?? 0;
      const brB = extractBRNumber(b.name) ?? 0;
      return brB - brA;
    });

    const winner = sorted[0];
    const losers = sorted.slice(1);

    // Detectar si el bedrooms real del campo es un empate entre >1 variante
    const maxBedrooms = winner.bedrooms;
    const tiedAtMax   = sorted.filter(v => v.bedrooms === maxBedrooms);

    if (tiedAtMax.length > 1) {
      // Hay empate en bedrooms — usamos el nombre BR number como desempate,
      // pero lo reportamos para revisión manual.
      tieGroups.push({ key, variants: sorted, winner });
    }

    winners.push({ ...winner, groupKey: key });

    for (const loser of losers) {
      toDisable.push({
        listing_id : loser.listing_id,
        name       : loser.name,
        bedrooms   : loser.bedrooms,
        br_in_name : extractBRNumber(loser.name),
        winner_name: winner.name,
        reason     : loser.bedrooms < winner.bedrooms
          ? `bedrooms ${loser.bedrooms} < max ${winner.bedrooms}`
          : `mismo bedrooms=${loser.bedrooms} pero nombre BR ${extractBRNumber(loser.name)} < ${extractBRNumber(winner.name)} (desempate)`,
      });
    }
  }

  // ── 5. Reporte ────────────────────────────────────────────────────────────
  log(`\n${"─".repeat(60)}`);
  log(`✅ GANADORES (quedan activos): ${winners.length}`);
  log(`🔴 A DESACTIVAR: ${toDisable.length}`);
  log(`⚠️  Grupos con empate en bedrooms (desempate por nombre): ${tieGroups.length}`);
  log(`${"─".repeat(60)}\n`);

  // Detalle por grupo
  log("📋 DETALLE POR GRUPO:\n");
  for (const [key, variants] of multiGroups) {
    const [pmc, base] = key.split("::");
    const sorted = [...variants].sort((a, b) => {
      const diff = (b.bedrooms ?? 0) - (a.bedrooms ?? 0);
      if (diff !== 0) return diff;
      return (extractBRNumber(b.name) ?? 0) - (extractBRNumber(a.name) ?? 0);
    });
    const winnerId = sorted[0].listing_id;

    log(`  📦 "${sorted[0].name.replace(BR_SUFFIX_RE, "").trim()}" — PMC: ${pmc || "(sin PMC)"}`);
    for (const v of sorted) {
      const isWinner = v.listing_id === winnerId;
      const tag = isWinner ? "✅ KEEP  " : "🔴 DISABLE";
      log(
        `     ${tag}  ${v.name.padEnd(40)} bedrooms=${String(v.bedrooms).padStart(2)}  is_listed=${v.is_listed}`
      );
    }
    log();
  }

  // Grupos con empate — advertencia detallada
  if (tieGroups.length > 0) {
    log(`${"─".repeat(60)}`);
    log("⚠️  GRUPOS CON EMPATE EN BEDROOMS (desempate automático por número en nombre):");
    log("   Revisa estos manualmente para confirmar que la elección es correcta.\n");
    for (const { key, variants, winner } of tieGroups) {
      const [pmc, base] = key.split("::");
      log(`  Grupo: "${base}" | PMC: ${pmc}`);
      log(`  → Ganador elegido: ${winner.name} (bedrooms=${winner.bedrooms}, BR en nombre=${extractBRNumber(winner.name)})`);
      for (const v of variants) {
        log(`    - ${v.name} | bedrooms=${v.bedrooms} | BR en nombre=${extractBRNumber(v.name)}`);
      }
      log();
    }
    log(`${"─".repeat(60)}\n`);
  }

  // Lista plana de IDs a desactivar
  const idsToDisable = toDisable.map(r => r.listing_id);

  log(`\n📌 RESUMEN FINAL:`);
  log(`   Grupos analizados       : ${multiGroups.length}`);
  log(`   Registros a desactivar  : ${idsToDisable.length}`);
  log(`   Registros a mantener    : ${winners.length}`);
  log(`   Grupos con empate       : ${tieGroups.length} (desempate automático aplicado)\n`);

  if (isDryRun) {
    log("🔍 DRY RUN completado. No se realizaron cambios.");
    log("   Para ejecutar los cambios, correr con flag --execute:\n");
    log("   node deactivate_br_variants.js --execute\n");
    writeReport(REPORT_DIR, REPORT_PATH, reportLines);
    await pool.end();
    return;
  }

  // ── 6. EXECUTE: UPDATE en batch ──────────────────────────────────────────
  if (idsToDisable.length === 0) {
    console.log("✅ Nada que desactivar.");
    await pool.end();
    return;
  }

  console.log(`⚡ Ejecutando UPDATE para ${idsToDisable.length} registros...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE public.listings
       SET
         villanet_enabled = false,
         is_listed        = false
       WHERE listing_id = ANY($1::text[])
         AND villanet_enabled = true`,
      [idsToDisable]
    );

    await client.query("COMMIT");

    log(`\n✅ UPDATE completado.`);
    log(`   Filas afectadas: ${result.rowCount}`);
    log(`   (Esperadas: ${idsToDisable.length} — diferencia indica registros ya desactivados)\n`);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error durante el UPDATE — ROLLBACK ejecutado:", err.message);
    throw err;
  } finally {
    client.release();
  }

  // ── 7. Verificación post-update ───────────────────────────────────────────
  const { rows: verification } = await pool.query(
    `SELECT listing_id, name, bedrooms, villanet_enabled, is_listed
     FROM public.listings
     WHERE listing_id = ANY($1::text[])
     ORDER BY name`,
    [idsToDisable]
  );

  const stillEnabled = verification.filter(r => r.villanet_enabled);
  if (stillEnabled.length > 0) {
    log(`⚠️  ${stillEnabled.length} registros siguen con villanet_enabled=true tras el update:`);
    stillEnabled.forEach(r => log(`   - ${r.name} (${r.listing_id})`));
  } else {
    log(`✅ Verificación OK: todos los registros desactivados correctamente.`);
  }

  log("\n🎉 Script completado.\n");
  writeReport(REPORT_DIR, REPORT_PATH, reportLines);
  await pool.end();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});