#!/usr/bin/env node
/**
 * villanet-verify-ids.js
 *
 * Script de verificación: compara las listing_ids del xlsx contra la DB
 * para detectar IDs incorrectas ANTES de correr el audit.
 *
 * Reporta:
 *   ✅  IDs que existen en DB y el nombre coincide bien
 *   ⚠️   IDs que existen en DB pero el nombre difiere (posible ID asignada a la villa equivocada)
 *   🔴  IDs que no existen en la DB en absoluto
 *   🟡  Filas sin listing_id en el xlsx
 *
 * Uso:
 *   node scripts/villanet-verify-ids.js
 *   node scripts/villanet-verify-ids.js --xlsx scripts/docs/Villa_Net_Tag_Database.xlsx
 *   node scripts/villanet-verify-ids.js --sim-threshold 0.6
 *
 * Output:
 *   scripts/docs/villanet-verify-ids-YYYY-MM-DD.csv
 *
 * Requiere: npm install xlsx dotenv pg
 */

'use strict';

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';

const { values: args } = parseArgs({
  options: {
    xlsx:            { type: 'string', default: 'scripts/docs/Villa_Net_Tag_Database.xlsx' },
    out:             { type: 'string', default: 'scripts/docs/villanet-verify-ids' },
    'sim-threshold': { type: 'string', default: '0.60' },
    help:            { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-verify-ids.js [options]

  --xlsx            Path al .xlsx con listing_ids  (default: scripts/docs/Villa_Net_Tag_Database.xlsx)
  --out             Prefijo para el CSV output     (default: scripts/docs/villanet-verify-ids)
  --sim-threshold   Similitud mínima para "nombre OK"  (default: 0.60)
  --help            Muestra este mensaje
`);
  process.exit(0);
}

const SIM_THRESHOLD = parseFloat(args['sim-threshold']);

// ── Smart similarity ──────────────────────────────────────────────────────────
// Understands common renaming patterns in this dataset:
//   - Suffix additions:  "Belair" → "Belair 6BR"
//   - Location strips:   "Eureka, Tryall Club" → "Eureka 4BR at the TC"
//   - Inverted order:    "Fathoms, Mahogany Bay" → "Mahogany Bay Fathoms"
// And correctly rejects near-misses:
//   - Number differs:    "Surf 211" vs "Surf 221"  → 0.00
//   - One word off:      "Little Hill" vs "Little Palm" → low
//   - Partial name:      "Sasha" vs "Sas" → 0.10

const LOCATION_SUFFIXES_RE = new RegExp(
  ',?\\s*(tryall club|sandy lane|royal westmoreland|sugar hill|mahogany bay|' +
  'merlin bay|mullins bay|apes hill|old trees|la cana|palmas|terrazas|' +
  'sandy line|cap cana|reino|at tc|at the tc|at s lane)\\b.*$', 'i'
);
const NOISE_WORDS = new Set(['villa','bay','cove','point','view','heights','ridge','estate','sl','tc','rwl']);
const BR_NOISE_RE = /\b(\d+br|\d+pax|\d+b\b|sb\d)\b/gi;
const PUNCT_RE    = /[^a-z0-9\s]/g;
const SPACES_RE   = /\s+/g;

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

function charSim(a, b) {
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length, 1);
}

function extractCore(s) {
  s = s.toLowerCase()
    .replace(LOCATION_SUFFIXES_RE, '')
    .replace(BR_NOISE_RE, '')
    .replace(PUNCT_RE, ' ')
    .replace(SPACES_RE, ' ')
    .trim();
  const tokens = s.split(' ').filter(t => t && !NOISE_WORDS.has(t));
  return tokens.length ? tokens : s.split(' ').filter(Boolean);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const al = a.toLowerCase(), bl = b.toLowerCase();

  const ta = extractCore(a);
  const tb = extractCore(b);
  const sa = new Set(ta), sb = new Set(tb);

  // 1. Differing numbers in core → completely different property
  const numsA = ta.join(' ').match(/\d+/g) || [];
  const numsB = tb.join(' ').match(/\d+/g) || [];
  if (numsA.length && numsB.length) {
    const setA = new Set(numsA), setB = new Set(numsB);
    const allMatch = [...setA].every(n => setB.has(n)) && [...setB].every(n => setA.has(n));
    if (!allMatch) return 0;
  }

  // 2. Very short cores (≤4 chars total): require exact match
  const minLen = Math.min(ta.join('').length, tb.join('').length);
  if (minLen <= 4) return ta.join(' ') === tb.join(' ') ? 1 : 0.1;

  // 3. Token subset check (one name's core tokens all appear in the other)
  const shorter = sa.size <= sb.size ? sa : sb;
  const longer  = sa.size <= sb.size ? sb : sa;
  if ([...shorter].every(t => longer.has(t))) {
    const coverage = shorter.size / longer.size;
    const base     = 0.80 + 0.18 * coverage;
    const fullSim  = charSim(al, bl);
    // Require stronger full-name support when core collapsed to a single token
    // with low coverage (likely a coincidental prefix match)
    const minFull  = (shorter.size === 1 && coverage < 0.5) ? 0.70
                   : (shorter.size === 1)                   ? 0.55
                   :                                          0.35;
    return fullSim < minFull ? Math.max(base * 0.55, fullSim) : base;
  }

  // 4. Short token sets (≤2 each): require majority overlap or score low
  if (sa.size <= 2 && sb.size <= 2) {
    const shared = [...sa].filter(t => sb.has(t)).length;
    const total  = new Set([...sa, ...sb]).size;
    return shared / total < 0.5 ? 0.2 : 0.65 + 0.30 * (shared / total);
  }

  // 5. Jaccard for longer token sets
  const shared  = [...sa].filter(t => sb.has(t)).length;
  const jaccard = shared / new Set([...sa, ...sb]).size;
  if (jaccard >= 0.5) return 0.65 + 0.30 * jaccard;

  // 6. Char-level fallback on cores
  const coreA = ta.join(' '), coreB = tb.join(' ');
  const coreSim = charSim(coreA, coreB);
  return coreSim >= 0.7 ? coreSim : charSim(al, bl) * 0.8;
}

// Best DB match by name (to suggest corrections)
function findBestByName(xlsxName, dbRows) {
  let best = 0, bestRow = null;
  for (const row of dbRows) {
    const s = similarity(xlsxName, row.name);
    if (s > best) { best = s; bestRow = row; }
  }
  return { match: bestRow, score: best };
}

// ── Verdict classification ────────────────────────────────────────────────────
// Returns { verdict, action } for a NAME_MISMATCH row.
//
//   ✅ correcta   — la ID está bien, el nombre cambió en DB (ej: "Eureka, TC" → "Eureka 4BR at TC")
//                  · la sugerencia tiene la MISMA id que la asignada, o
//                  · el core del nombre xlsx está contenido en el db_name
//
//   ❌ incorrecta — la ID apunta a una propiedad distinta y hay una sugerencia con sim ≥ 0.90
//
//   ⚠️  revisar   — no se puede determinar con certeza (similitud de sugerencia < 0.90)

const LOCATION_STRIP_RE = new RegExp(
  ',?\\s*(tryall club|sandy lane|royal westmoreland|sugar hill|mahogany bay|' +
  'merlin bay|mullins bay|apes hill|cap cana|reino|at tc|at the tc)\\b.*$', 'i'
);

function classifyMismatch(xlsxName, assignedId, dbName, suggestedId, suggestedSim) {
  const sameId = suggestedId === assignedId;

  // Check if xlsx core is a substring of the db_name (classic rename pattern)
  let xlsxCore = xlsxName.toLowerCase()
    .replace(LOCATION_STRIP_RE, '')
    .replace(/\b(villa|house|beach)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isRename = xlsxCore.length > 2 && dbName.toLowerCase().includes(xlsxCore);

  if (sameId || isRename) {
    return { verdict: '✅ correcta', action: 'Mantener ID' };
  }
  if (suggestedSim >= 0.90) {
    return {
      verdict: '❌ incorrecta',
      action:  `Cambiar a → ${suggestedId}`,
    };
  }
  return { verdict: '⚠️  revisar', action: 'Verificar manualmente' };
}

// ── Load xlsx ─────────────────────────────────────────────────────────────────
async function loadXlsx(filePath) {
  let xlsx;
  try { xlsx = (await import('xlsx')).default; } catch {
    console.error('\n❌  Falta el módulo xlsx. Instalalo con:  npm install xlsx\n');
    process.exit(1);
  }
  const wb   = xlsx.readFile(filePath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  return rows
    .filter(r => r['Unit Name']?.toString().trim())
    .map(r => ({
      xlsxName:   r['Unit Name'].toString().trim(),
      listingId:  r['listing_id']?.toString().trim() || null,
      pmc:        r['PMC-INFORMATION']?.toString().trim() || null,
      city:       r['CITY']?.toString().trim() || null,
    }));
}

// ── Load DB (all listings, not just active) ───────────────────────────────────
async function loadFromDB(pool) {
  const { rows } = await pool.query(`
    SELECT listing_id, name, villanet_enabled, is_listed,
           villanet_pmc_information
    FROM listings
    ORDER BY name
  `);
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = path.resolve(args.xlsx);
  const dateStr  = new Date().toISOString().slice(0, 10);
  const outBase  = path.resolve(`${args.out}-${dateStr}`);

  fs.mkdirSync(path.dirname(outBase), { recursive: true });

  if (!fs.existsSync(xlsxPath)) {
    console.error(`❌  No se encontró el XLSX: ${xlsxPath}`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' VillaNet — Verificación de listing_ids');
  console.log(`  xlsx: ${xlsxPath}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const pool = new Pool({
    host:     process.env.PGHOST,
    port:     Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGHOST === 'localhost' || process.env.PGHOST === '127.0.0.1'
      ? false
      : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 1000000,
  });

  console.log('📂  Cargando datos...');
  let xlsxRows, dbRows;
  try {
    [xlsxRows, dbRows] = await Promise.all([loadXlsx(xlsxPath), loadFromDB(pool)]);
  } catch (err) {
    console.error('❌  Error cargando datos:', err.message);
    await pool.end();
    process.exit(1);
  }

  const dbById   = new Map(dbRows.map(r => [r.listing_id, r]));
  const withId   = xlsxRows.filter(r => r.listingId);
  const withoutId = xlsxRows.filter(r => !r.listingId);

  console.log(`✅  XLSX: ${xlsxRows.length} propiedades (${withId.length} con listing_id, ${withoutId.length} sin)`);
  console.log(`✅  DB (todos): ${dbRows.length} listings`);
  console.log(`📐  Umbral similitud de nombre: ${SIM_THRESHOLD}\n`);

  const results = {
    ok:           [],  // ID existe + nombre OK
    name_mismatch:[],  // ID existe + nombre diverge
    not_in_db:    [],  // ID no existe en DB
    no_id:        [],  // Fila sin listing_id
  };

  for (const row of withId) {
    const dbRow = dbById.get(row.listingId);

    if (!dbRow) {
      results.not_in_db.push(row);
      continue;
    }

    const sim = similarity(row.xlsxName, dbRow.name);

    if (sim >= SIM_THRESHOLD) {
      results.ok.push({ ...row, dbName: dbRow.name, sim, active: dbRow.villanet_enabled && dbRow.is_listed });
    } else {
      // Find the best DB match by name to suggest a correction
      const { match: bestByName, score: bestScore } = findBestByName(row.xlsxName, dbRows);
      const suggestedId   = bestByName?.listing_id || null;
      const suggestedName = bestByName?.name        || null;
      const { verdict, action } = classifyMismatch(
        row.xlsxName, row.listingId, dbRow.name, suggestedId, bestScore
      );
      results.name_mismatch.push({
        ...row,
        dbName:            dbRow.name,
        sim,
        dbVillanetEnabled: dbRow.villanet_enabled,
        dbIsListed:        dbRow.is_listed,
        suggestedName,
        suggestedId,
        suggestedSim:      bestScore,
        verdict,
        action,
      });
    }
  }

  for (const row of withoutId) {
    const { match, score } = findBestByName(row.xlsxName, dbRows);
    results.no_id.push({
      ...row,
      suggestedName: match?.name || null,
      suggestedId:   match?.listing_id || null,
      suggestedSim:  score,
    });
  }

  // ── Consola ───────────────────────────────────────────────────────────────
  const wrongCount   = results.name_mismatch.filter(r => r.verdict === '❌ incorrecta').length;
  const reviewCount  = results.name_mismatch.filter(r => r.verdict === '⚠️  revisar').length;
  const renamedCount = results.name_mismatch.filter(r => r.verdict === '✅ correcta').length;

  console.log('─'.repeat(60));
  console.log(`✅  IDs correctas (nombre OK)       : ${results.ok.length + renamedCount}`);
  console.log(`❌  IDs incorrectas → corregir      : ${wrongCount}`);
  console.log(`⚠️   Revisar manualmente             : ${reviewCount}`);
  console.log(`🔴  IDs que no existen en DB         : ${results.not_in_db.length}`);
  console.log(`🟡  Filas sin listing_id             : ${results.no_id.length}`);
  console.log('─'.repeat(60));

  if (results.not_in_db.length > 0) {
    console.log('\n🔴  IDs QUE NO EXISTEN EN LA DB:');
    for (const r of results.not_in_db) {
      console.log(`    • "${r.xlsxName}" [${r.pmc}]  →  ${r.listingId}`);
    }
  }

  if (results.name_mismatch.length > 0) {
    const wrong   = results.name_mismatch.filter(r => r.verdict === '❌ incorrecta');
    const review  = results.name_mismatch.filter(r => r.verdict === '⚠️  revisar');
    const renamed = results.name_mismatch.filter(r => r.verdict === '✅ correcta');

    console.log(`\n📊  Desglose de ${results.name_mismatch.length} mismatches:`);
    console.log(`    ✅  Correctas (solo renombradas) : ${renamed.length}`);
    console.log(`    ❌  Incorrectas → corregir       : ${wrong.length}`);
    console.log(`    ⚠️   Revisar manualmente          : ${review.length}`);

    if (wrong.length > 0) {
      console.log('\n❌  IDs INCORRECTAS — corregir en el xlsx:');
      for (const r of wrong) {
        console.log(`    • "${r.xlsxName}" [${r.pmc}]`);
        console.log(`      Tiene:    "${r.dbName}"  (${r.listingId})`);
        console.log(`      Debería:  "${r.suggestedName}"  (${r.suggestedId})  sim=${r.suggestedSim.toFixed(2)}`);
      }
    }

    if (review.length > 0) {
      console.log('\n⚠️   REVISAR MANUALMENTE:');
      for (const r of review) {
        const active = (r.dbVillanetEnabled && r.dbIsListed) ? '🟢' : '🔴';
        console.log(`    • "${r.xlsxName}" [${r.pmc}]`);
        console.log(`      Tiene:    "${r.dbName}" ${active}  (sim=${r.sim.toFixed(2)})`);
        if (r.suggestedId && r.suggestedId !== r.listingId) {
          console.log(`      Sugerida: "${r.suggestedName}"  (${r.suggestedId})  sim=${r.suggestedSim.toFixed(2)}`);
        }
      }
    }
  }

  if (results.no_id.length > 0) {
    console.log(`\n🟡  FILAS SIN listing_id (${results.no_id.length}):`);
    for (const r of results.no_id) {
      console.log(`    • "${r.xlsxName}" [${r.pmc}]  →  mejor match: "${r.suggestedName}" (${r.suggestedSim.toFixed(2)}) ${r.suggestedId}`);
    }
  }

  await pool.end();

  // ── CSV ───────────────────────────────────────────────────────────────────
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const csvLines = [
    '## VERIFICACIÓN DE listing_ids — VillaNet xlsx vs DB',
    '',
    '## ✅ IDs CORRECTAS',
    'status,xlsx_name,pmc,listing_id,db_name,similarity,db_active',
    ...results.ok.map(r => [
      'OK', esc(r.xlsxName), esc(r.pmc), esc(r.listingId),
      esc(r.dbName), r.sim.toFixed(2), r.active,
    ].join(',')),

    '',
    '## ❌ IDs INCORRECTAS — cambiar en el xlsx',
    'status,verdict,xlsx_name,pmc,listing_id,db_name,similarity,db_active,suggested_name,suggested_id,suggested_sim,action',
    ...results.name_mismatch.filter(r => r.verdict === '❌ incorrecta').map(r => [
      'NAME_MISMATCH', esc(r.verdict), esc(r.xlsxName), esc(r.pmc), esc(r.listingId),
      esc(r.dbName), r.sim.toFixed(2),
      (r.dbVillanetEnabled && r.dbIsListed) ? 'true' : 'false',
      esc(r.suggestedName), esc(r.suggestedId), r.suggestedSim.toFixed(2), esc(r.action),
    ].join(',')),

    '',
    '## ⚠️ REVISAR MANUALMENTE',
    'status,verdict,xlsx_name,pmc,listing_id,db_name,similarity,db_active,suggested_name,suggested_id,suggested_sim,action',
    ...results.name_mismatch.filter(r => r.verdict === '⚠️  revisar').map(r => [
      'NAME_MISMATCH', esc(r.verdict), esc(r.xlsxName), esc(r.pmc), esc(r.listingId),
      esc(r.dbName), r.sim.toFixed(2),
      (r.dbVillanetEnabled && r.dbIsListed) ? 'true' : 'false',
      esc(r.suggestedName), esc(r.suggestedId), r.suggestedSim.toFixed(2), esc(r.action),
    ].join(',')),

    '',
    '## ✅ CORRECTAS (solo renombradas en DB)',
    'status,verdict,xlsx_name,pmc,listing_id,db_name,similarity,db_active',
    ...results.name_mismatch.filter(r => r.verdict === '✅ correcta').map(r => [
      'NAME_MISMATCH', esc(r.verdict), esc(r.xlsxName), esc(r.pmc), esc(r.listingId),
      esc(r.dbName), r.sim.toFixed(2),
      (r.dbVillanetEnabled && r.dbIsListed) ? 'true' : 'false',
    ].join(',')),

    '',
    '## 🔴 IDs QUE NO EXISTEN EN DB',
    'status,xlsx_name,pmc,listing_id',
    ...results.not_in_db.map(r => [
      'NOT_IN_DB', esc(r.xlsxName), esc(r.pmc), esc(r.listingId),
    ].join(',')),

    '',
    '## 🟡 FILAS SIN listing_id',
    'status,xlsx_name,pmc,suggested_name,suggested_id,suggested_sim',
    ...results.no_id.map(r => [
      'NO_ID', esc(r.xlsxName), esc(r.pmc),
      esc(r.suggestedName), esc(r.suggestedId), r.suggestedSim.toFixed(2),
    ].join(',')),
  ];

  const csvPath = `${outBase}.csv`;
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`\n📄  CSV  → ${csvPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  process.exit(1);
});