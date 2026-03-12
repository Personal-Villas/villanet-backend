#!/usr/bin/env node
/**
 * villanet-catalog-check.js
 *
 * Compara el catálogo Villa Net V1.0 (.xlsx) contra la tabla listings de la DB
 * y genera un reporte con tres categorías:
 *
 *   matched_active   → villanet_enabled = true  (visible en /properties ahora mismo)
 *   matched_inactive → existe en DB pero villanet_enabled = false  (falta activar)
 *   not_found        → no existe en DB  (hay que crear desde cero)
 *
 * Uso:
 *   node scripts/villanet-catalog-check.js \
 *     --xlsx  ../Villa_Net_V1_0_Tag_Database.xlsx \
 *     --out   ../villanet-report \
 *     --threshold 0.8
 *
 * Requiere: npm install xlsx dotenv pg
 */

'use strict';

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { parseArgs } from 'util';
import { Pool } from 'pg';

// ── CLI args ──────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    xlsx:      { type: 'string',  default: '../Villa_Net_V1_0_Tag_Database.xlsx' },
    out:       { type: 'string',  default: '../villanet-report' },
    threshold: { type: 'string',  default: '0.8' },
    help:      { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-catalog-check.js [options]

  --xlsx       Path to Villa Net .xlsx         (default: ../Villa_Net_V1_0_Tag_Database.xlsx)
  --out        Output path prefix              (default: ../villanet-report)
  --threshold  Fuzzy similarity 0-1            (default: 0.8)
  --help       Show this message
`);
  process.exit(0);
}

const THRESHOLD = parseFloat(args.threshold);

// ── Fuzzy matching (Levenshtein puro, sin dependencias externas) ──────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[m][n];
}

// Elimina "villa" para que "Villa Agave" y "Agave Villa" sean equivalentes
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\bvilla\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}

function findBestMatch(name, dbRows) {
  let bestScore = -1, bestRow = null;
  for (const row of dbRows) {
    const s = similarity(name, row.name);
    if (s > bestScore) { bestScore = s; bestRow = row; }
  }
  return { match: bestRow, score: bestScore };
}

// Busca variantes en DB cuyo nombre empieza con el nombre del xlsx
// Usado solo cuando findBestMatch no supera el threshold
function findPrefixVariants(name, dbRows) {
  const na = normalize(name);
  if (na.length < 4) return [];
  return dbRows.filter(row => normalize(row.name).startsWith(na));
}

// ── XLSX loader ───────────────────────────────────────────────────────────────
async function loadXlsx(filePath) {
  let xlsx;
  try { xlsx = (await import('xlsx')).default; } catch {
    console.error('\n❌  Falta el módulo xlsx. Instalalo con:  npm install xlsx\n');
    process.exit(1);
  }
  const wb   = xlsx.readFile(filePath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
  return rows.map(r => (r['Unit Name'] || '').trim()).filter(Boolean);
}

// ── DB loader — mismas columnas que usan las rutas ────────────────────────────
async function loadFromDB(pool) {
  const { rows } = await pool.query(`
    SELECT
      listing_id,
      name,
      villanet_enabled,
      -- images_empty: true si los tres campos de imágenes están vacíos
      (
        (villanet_hero_images IS NULL OR villanet_hero_images = '[]'::jsonb) AND
        (images_json          IS NULL OR images_json          = '[]'::jsonb) AND
        (hero_image_url       IS NULL OR hero_image_url       = '')
      ) AS images_empty
    FROM listings
    ORDER BY name
  `);
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = path.resolve(args.xlsx);
  const outBase  = path.resolve(args.out);

  if (!fs.existsSync(xlsxPath)) {
    console.error(`❌  No se encontró el XLSX: ${xlsxPath}`);
    process.exit(1);
  }

  // Conexión a la DB usando las mismas variables que db.js
  const pool = new Pool({
    host:     process.env.PGHOST,
    port:     Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 10000,
  });

  console.log('\n📂  Cargando datos...');

  let xlsxNames, dbRows;
  try {
    [xlsxNames, dbRows] = await Promise.all([
      loadXlsx(xlsxPath),
      loadFromDB(pool),
    ]);
  } catch (err) {
    console.error('❌  Error cargando datos:', err.message);
    await pool.end();
    process.exit(1);
  }

  await pool.end();

  console.log(`✅  Villa Net catalog : ${xlsxNames.length} propiedades`);
  console.log(`✅  DB listings       : ${dbRows.length} filas`);
  console.log(`🔎  Fuzzy threshold   : ${THRESHOLD}\n`);

  const report = {
    summary: { matched_active: 0, matched_inactive: 0, partial_match: 0, not_found: 0 },
    matched_active:   [],
    matched_inactive: [],
    partial_match:    [],
    not_found:        [],
  };

  for (const xlsxName of xlsxNames) {
    const { match, score } = findBestMatch(xlsxName, dbRows);

    if (!match || score < THRESHOLD) {
      // No supera el threshold \u2014 buscar variantes por prefijo
      const variants = findPrefixVariants(xlsxName, dbRows);
      if (variants.length) {
        // Hay variantes en DB que empiezan con este nombre
        const variantNames = variants.map(v => v.name).join(' | ');
        const variantIds   = variants.map(v => v.listing_id).join(' | ');
        report.partial_match.push({
          villanet_name:   xlsxName,
          variant_names:   variantNames,
          variant_ids:     variantIds,
          variants_count:  variants.length,
        });
        report.summary.partial_match++;
      } else {
        report.not_found.push({ villanet_name: xlsxName });
        report.summary.not_found++;
      }
      continue;
    }

    // 1000 para match perfecto, decimal para fuzzy
    const displayScore = score === 1 ? 1000 : +score.toFixed(3);

    const base = {
      villanet_name:    xlsxName,
      db_name:          match.name,
      listing_id:       match.listing_id,
      similarity_score: displayScore,
      villanet_enabled: match.villanet_enabled,
      images_empty:     match.images_empty,
    };

    if (match.villanet_enabled) {
      report.matched_active.push(base);
      report.summary.matched_active++;
    } else {
      report.matched_inactive.push(base);
      report.summary.matched_inactive++;
    }
  }

  // ── JSON ──────────────────────────────────────────────────────────────────
  const jsonPath = `${outBase}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`📄  JSON → ${jsonPath}`);

  // ── CSV ───────────────────────────────────────────────────────────────────
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csvLines = [
    'category,villanet_name,db_name,listing_id,similarity_score,villanet_enabled,images_empty,variant_names,variant_ids',
  ];

  for (const r of report.matched_active)
    csvLines.push(`matched_active,${esc(r.villanet_name)},${esc(r.db_name)},${esc(r.listing_id)},${r.similarity_score},true,,`);

  for (const r of report.matched_inactive)
    csvLines.push(`matched_inactive,${esc(r.villanet_name)},${esc(r.db_name)},${esc(r.listing_id)},${r.similarity_score},false,${r.images_empty},,`);

  for (const r of report.partial_match)
    csvLines.push(`partial_match,${esc(r.villanet_name)},,,,,, ${esc(r.variant_names)},${esc(r.variant_ids)}`);

  for (const r of report.not_found)
    csvLines.push(`not_found,${esc(r.villanet_name)},,,,,,`);

  const csvPath = `${outBase}.csv`;
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`📄  CSV  → ${csvPath}`);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────');
  console.log(`✅  Matched & Active   : ${report.summary.matched_active}`);
  console.log(`⚠️   Matched & Inactive : ${report.summary.matched_inactive}`);
  console.log(`🔍  Partial Match      : ${report.summary.partial_match}`);
  console.log(`❌  Not Found          : ${report.summary.not_found}`);
  console.log('──────────────────────────────────────────────');

  const sinImagenes = report.matched_inactive.filter(r => r.images_empty);
  const conImagenes = report.matched_inactive.filter(r => !r.images_empty);
  if (report.matched_inactive.length > 0) {
    console.log(`\n   De los ${report.matched_inactive.length} inactivos:`);
    console.log(`   📷  Sin imágenes (probable bloqueante) : ${sinImagenes.length}`);
    console.log(`   🖼️   Con imágenes (revisar otro motivo) : ${conImagenes.length}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  process.exit(1);
});