#!/usr/bin/env node
/**
 * villanet-audit.js
 *
 * Auditoría de integridad: compara los campos Villanet del archivo maestro
 * (.xlsx de Robbie) contra la tabla listings de la DB.
 *
 * Solo procesa registros donde: villanet_enabled = true AND is_listed = true
 *
 * Matching:
 *   - Si la fila del xlsx tiene columna "listing_id" con valor → match directo por ID
 *   - Si no → fallback a fuzzy match por nombre (comportamiento anterior)
 *
 * Modos:
 *   node scripts/villanet-audit.js               → Dry run (solo reporta, no escribe)
 *   node scripts/villanet-audit.js --update       → Aplica correcciones en DB
 *   node scripts/villanet-audit.js --field villanet_commission_rate --update
 *                                                 → Solo actualiza un campo específico
 *
 * Output:
 *   scripts/docs/villanet-audit-YYYY-MM-DD.json   → Discrepancias + columnas nuevas
 *   scripts/docs/villanet-audit-YYYY-MM-DD.csv    → Tres secciones:
 *                                                    1. Discrepancias (con similarity%)
 *                                                    2. Sin match (revisión manual)
 *                                                    3. Columnas nuevas en xlsx (AC5)
 *
 * Requiere: npm install xlsx dotenv pg
 */

'use strict';

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';

// ── CLI ───────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    xlsx:      { type: 'string',  default: 'scripts/docs/Villa_Net_Tag_Database.xlsx' },
    out:       { type: 'string',  default: 'scripts/docs/villanet-audit' },
    threshold: { type: 'string',  default: '0.82' },
    update:    { type: 'boolean', default: false },
    field:     { type: 'string',  default: '' },
    help:      { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-audit.js [options]

  --xlsx       Path al .xlsx de Robbie    (default: scripts/docs/Villa_Net_Tag_Database.xlsx)
  --out        Prefijo para los reportes  (default: scripts/docs/villanet-audit)
  --threshold  Similitud fuzzy mínima     (default: 0.82)  [solo aplica al fallback por nombre]
  --update     Aplica correcciones en DB  (default: false = dry run)
  --field      Limitar update a un campo específico (ej: villanet_commission_rate)
  --help       Muestra este mensaje
`);
  process.exit(0);
}

const IS_DRY_RUN  = !args.update;
const THRESHOLD   = parseFloat(args.threshold);
const FIELD_ONLY  = args.field?.trim() || null;

// ── Mapping Excel → DB ────────────────────────────────────────────────────────
const FIELD_MAP = [
  ['VILLA NET DESTINATION TAG',          'villanet_destination_tag',            'string'],
  ['CITY',                               'villanet_city',                       'string'],
  ['PMC-INFORMATION',                    'villanet_pmc_information',            'string'],
  ['PROPERTY-EMAIL',                     'villanet_property_email',             'string'],
  ['VILLA NET PROPERTY MANAGER NAME',    'villanet_property_manager_name',      'string'],
  ['VILLA NET PARTNER RESERVATION EMAIL','villanet_partner_reservation_email',  'string'],
  ['VILLA NET STAFF GRATUITY GUIDELINE', 'villanet_staff_gratuity_guideline',   'string'],
  ['VILLA NET RESORT COLLECTION NAME',   'villanet_resort_collection_name',     'string'],
  ['VILLA NET RANK',                     'villanet_rank',                       'number'],
  ['VILLA NET COMMISSION RATE',          'villanet_commission_rate',            'number'],
  ['VILLA NET EXCLUSIVE UNITS MANAGED',  'villanet_exclusive_units_managed',    'number'],
  ['VILLA NET YEARS IN BUSINESS',        'villanet_years_in_business',          'number'],
  ['VILLA NET AVG RESPONSE TIME HOURS',  'villanet_avg_response_time_hours',    'number'],
  ['VILLA NET CALENDAR SYNC 99',         'villanet_calendar_sync_99',           'bool'],
  ['VILLA NET CREDIT CARD ACCEPTED',     'villanet_credit_card_accepted',       'bool'],
  ['VILLA NET INSURED',                  'villanet_insured',                    'bool'],
  ['VILLA NET BANK TRANSFER ACCEPTED',   'villanet_bank_transfer_accepted',     'bool'],
  ['VILLA NET STANDARDIZED HOUSEKEEPING','villanet_standardized_housekeeping',  'bool'],
  ['VILLA NET GATED COMMUNITY',          'villanet_gated_community',            'bool'],
  ['VILLA NET GOLF VILLA',               'villanet_golf_villa',                 'bool'],
  ['VILLA NET RESORT VILLA',             'villanet_resort_villa',               'bool'],
  ['VILLA NET CHEF INCLUDED',            'villanet_chef_included',              'bool'],
  ['VILLA NET TRUE BEACH FRONT',         'villanet_true_beach_front',           'bool'],
  ['VILLA NET COOK INCLUDED',            'villanet_cook_included',              'bool'],
  ['VILLA NET WAITER BUTLER INCLUDED',   'villanet_waiter_butler_included',     'bool'],
  ['VILLA NET OCEAN FRONT',              'villanet_ocean_front',                'bool'],
  ['VILLA NET OCEAN VIEW',               'villanet_ocean_view',                 'bool'],
  ['VILLA NET WALK TO BEACH',            'villanet_walk_to_beach',              'bool'],
  ['VILLA NET ACCESSIBLE',               'villanet_accessible',                 'bool'],
  ['VILLA NET PRIVATE GYM',              'villanet_private_gym',                'bool'],
  ['VILLA NET PRIVATE CINEMA',           'villanet_private_cinema',             'bool'],
  ['VILLA NET PICKLEBALL',               'villanet_pickleball',                 'bool'],
  ['VILLA NET TENNIS',                   'villanet_tennis',                     'bool'],
  ['VILLA NET GOLF CART INCLUDED',       'villanet_golf_cart_included',         'bool'],
  ['VILLA NET HEATED POOL',              'villanet_heated_pool',                'bool'],
];

const ACTIVE_FIELD_MAP = FIELD_ONLY
  ? FIELD_MAP.filter(([, db]) => db === FIELD_ONLY)
  : FIELD_MAP;

if (FIELD_ONLY && !ACTIVE_FIELD_MAP.length) {
  console.error(`❌  Campo "${FIELD_ONLY}" no está en el mapa de auditoría.`);
  console.error(`    Campos válidos: ${FIELD_MAP.map(([, db]) => db).join(', ')}`);
  process.exit(1);
}

// ── Fuzzy matching (fallback cuando no hay listing_id en xlsx) ────────────────
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

function findBestMatch(xlsxName, dbRows) {
  let best = -1, bestRow = null;
  for (const row of dbRows) {
    const s = similarity(xlsxName, row.name);
    if (s > best) { best = s; bestRow = row; }
  }
  return { match: bestRow, score: best };
}

// ── Normalización de valores ──────────────────────────────────────────────────
function normalizeXlsxValue(raw, type) {
  if (raw === null || raw === undefined) return null;
  if (type === 'bool') {
    const s = String(raw).trim().toLowerCase();
    if (s === 'yes' || s === 'true' || s === '1') return true;
    if (s === 'no'  || s === 'false'|| s === '0') return false;
    return null;
  }
  if (type === 'number') {
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
  const s = String(raw).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

function normalizeDbValue(raw, type) {
  if (raw === null || raw === undefined) return null;
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  if (type === 'number') {
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
  return String(raw).trim() || null;
}

function valuesMatch(xlsxVal, dbVal, type) {
  if (xlsxVal === null && dbVal === null) return true;
  if (xlsxVal === null || dbVal === null) return false;
  if (type === 'number') return Math.abs(xlsxVal - dbVal) < 0.001;
  if (type === 'string') return xlsxVal.toLowerCase() === dbVal.toLowerCase();
  return xlsxVal === dbVal;
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

  const xlsxColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const hasIdCol    = xlsxColumns.includes('listing_id');

  const parsed = rows
    .filter(r => r['Unit Name']?.toString().trim())
    .map(r => {
      const entry = {
        xlsxName:   r['Unit Name'].trim(),
        xlsxListingId: hasIdCol ? (r['listing_id']?.toString().trim() || null) : null,
      };
      for (const [xlsxCol, dbCol, type] of FIELD_MAP) {
        entry[dbCol] = normalizeXlsxValue(r[xlsxCol], type);
      }
      return entry;
    });

  return { rows: parsed, xlsxColumns, hasIdCol };
}

// ── DB loader ─────────────────────────────────────────────────────────────────
async function loadFromDB(pool) {
  const dbCols = FIELD_MAP.map(([, db]) => `l.${db}`).join(',\n      ');
  const { rows } = await pool.query(`
    SELECT
      l.listing_id,
      l.name,
      l.villanet_enabled,
      l.is_listed,
      ${dbCols}
    FROM listings l
    WHERE l.villanet_enabled = true
      AND l.is_listed = true
    ORDER BY l.name
  `);
  return rows;
}

// ── DB update ─────────────────────────────────────────────────────────────────
async function applyUpdates(pool, updates) {
  const byId = new Map();
  for (const u of updates) {
    if (!byId.has(u.listing_id)) byId.set(u.listing_id, []);
    byId.get(u.listing_id).push(u);
  }

  let applied = 0;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const [listing_id, fields] of byId) {
      const setClauses = [];
      const values     = [];
      const dedupedFields = new Map();
      for (const f of fields) dedupedFields.set(f.field, f);

      for (const { field, xlsx_value } of dedupedFields.values()) {
        values.push(xlsx_value);
        setClauses.push(`${field} = $${values.length}`);
      }

      values.push(listing_id);
      await client.query(
        `UPDATE listings SET ${setClauses.join(', ')}, updated_at = NOW()
         WHERE listing_id = $${values.length}`,
        values
      );
      applied += fields.length;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { rows_updated: byId.size, fields_updated: applied };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = path.resolve(args.xlsx);
  const dateStr  = new Date().toISOString().slice(0, 10);
  const outBase  = path.resolve(`${args.out}-${dateStr}`);

  fs.mkdirSync(path.dirname(outBase), { recursive: true });

  if (!fs.existsSync(xlsxPath)) {
    console.error(`❌  No se encontró el XLSX: ${xlsxPath}`);
    console.error(`    Ubicalo en scripts/docs/ o pasá --xlsx <path>.`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' VillaNet — Audit Script');
  console.log(` Mode   : ${IS_DRY_RUN ? '🔍 DRY RUN (sin cambios en DB)' : '⚡ UPDATE (aplicando correcciones)'}`);
  if (FIELD_ONLY) console.log(` Filtro : solo campo "${FIELD_ONLY}"`);
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
    max: 5,
    connectionTimeoutMillis: 1000000,
  });

  console.log('📂  Cargando datos...');

  let xlsxResult, dbRows;
  try {
    [xlsxResult, dbRows] = await Promise.all([loadXlsx(xlsxPath), loadFromDB(pool)]);
  } catch (err) {
    console.error('❌  Error cargando datos:', err.message);
    await pool.end();
    process.exit(1);
  }

  const { rows: xlsxRows, xlsxColumns, hasIdCol } = xlsxResult;

  // AC5: columnas nuevas en xlsx
  const knownXlsxCols = new Set([
    'listing_id',
    'Unit Name',
    'Current Guesty Tags',
    ...FIELD_MAP.map(([xlsxCol]) => xlsxCol),
  ]);
  const unknownCols = xlsxColumns.filter(col => !knownXlsxCols.has(col));

  // Build DB index by listing_id for direct lookups
  const dbById = new Map(dbRows.map(r => [r.listing_id, r]));

  console.log(`✅  XLSX (catálogo Robbie)          : ${xlsxRows.length} propiedades`);
  console.log(`✅  DB (villanet_enabled + is_listed): ${dbRows.length} propiedades`);
  console.log(`🔑  Modo matching                   : ${hasIdCol ? 'listing_id directo (con fallback fuzzy)' : 'fuzzy por nombre'}`);
  console.log(`🔎  Fuzzy threshold                 : ${THRESHOLD}${hasIdCol ? ' (solo fallback)' : ''}`);
  console.log(`📋  Campos auditados                : ${ACTIVE_FIELD_MAP.length}`);

  if (unknownCols.length > 0) {
    console.log(`\n🆕  COLUMNAS NUEVAS EN XLSX (no están en el esquema actual):`);
    for (const col of unknownCols) {
      console.log(`    • "${col}"  ← requiere evaluación para agregar al esquema`);
    }
  } else {
    console.log(`✅  Sin columnas nuevas en el xlsx — esquema al día`);
  }
  console.log('');

  // ── Matching y comparación ────────────────────────────────────────────────
  const results = {
    matched_ok:    [],
    matched_diffs: [],
    no_match:      [],
    id_not_in_db:  [],  // listing_id presente en xlsx pero no en DB activa
  };

  const allDiscrepancies = [];

  for (const xlsxRow of xlsxRows) {
    let match  = null;
    let score  = null;
    let method = 'fuzzy';

    // 1. Match directo por listing_id si está disponible
    if (xlsxRow.xlsxListingId) {
      const directMatch = dbById.get(xlsxRow.xlsxListingId);
      if (directMatch) {
        match  = directMatch;
        score  = 1000;   // sentinel: match exacto por ID
        method = 'id';
      } else {
        // ID existe en xlsx pero no en la vista activa de DB
        results.id_not_in_db.push({
          xlsx_name:    xlsxRow.xlsxName,
          listing_id:   xlsxRow.xlsxListingId,
          reason:       'not in DB active view (villanet_enabled=true AND is_listed=true)',
        });
        continue;
      }
    }

    // 2. Fallback: fuzzy por nombre
    if (!match) {
      const result = findBestMatch(xlsxRow.xlsxName, dbRows);
      if (!result.match || result.score < THRESHOLD) {
        results.no_match.push({
          xlsx_name:    xlsxRow.xlsxName,
          best_db_name: result.match?.name || null,
          best_score:   result.match ? +result.score.toFixed(3) : null,
        });
        continue;
      }
      match  = result.match;
      score  = result.score;
      method = 'fuzzy';
    }

    // Comparar campos
    const diffs = [];
    for (const [, dbCol, type] of ACTIVE_FIELD_MAP) {
      const xlsxVal = xlsxRow[dbCol];
      const dbVal   = normalizeDbValue(match[dbCol], type);
      if (!valuesMatch(xlsxVal, dbVal, type)) {
        diffs.push({
          listing_id: match.listing_id,
          db_name:    match.name,
          xlsx_name:  xlsxRow.xlsxName,
          field:      dbCol,
          type,
          xlsx_value: xlsxVal,
          db_value:   dbVal,
          score:      score === 1000 ? 1 : +score.toFixed(3),
          method,
        });
      }
    }

    const scoreOut = score === 1000 ? 1000 : +score.toFixed(3);

    if (diffs.length === 0) {
      results.matched_ok.push({
        xlsx_name:  xlsxRow.xlsxName,
        db_name:    match.name,
        listing_id: match.listing_id,
        score:      scoreOut,
        method,
      });
    } else {
      results.matched_diffs.push({
        xlsx_name:  xlsxRow.xlsxName,
        db_name:    match.name,
        listing_id: match.listing_id,
        score:      scoreOut,
        diff_count: diffs.length,
        method,
        diffs,
      });
      allDiscrepancies.push(...diffs);
    }
  }

  // ── Resumen en consola ────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log(`✅  Matched sin diferencias  : ${results.matched_ok.length}`);
  console.log(`⚠️   Matched con diferencias  : ${results.matched_diffs.length}`);
  console.log(`❌  Sin match en DB           : ${results.no_match.length}`);
  if (results.id_not_in_db.length > 0) {
    console.log(`🔴  ID en xlsx no activa en DB: ${results.id_not_in_db.length}`);
  }
  console.log(`📊  Total discrepancias       : ${allDiscrepancies.length}`);
  console.log('─'.repeat(60));

  if (results.id_not_in_db.length > 0) {
    console.log('\n🔴  LISTING_IDs EN XLSX SIN MATCH ACTIVO EN DB:');
    console.log('    (propiedad existe en DB pero villanet_enabled=false o is_listed=false)\n');
    for (const r of results.id_not_in_db) {
      console.log(`    • "${r.xlsx_name}"  →  ${r.listing_id}`);
    }
    console.log('');
  }

  if (allDiscrepancies.length > 0) {
    const byField = {};
    for (const d of allDiscrepancies) {
      byField[d.field] = (byField[d.field] || 0) + 1;
    }
    const sorted = Object.entries(byField).sort((a, b) => b[1] - a[1]);
    console.log('\n📋  Campos con más discrepancias:');
    for (const [field, count] of sorted.slice(0, 10)) {
      const pct = ((count / results.matched_diffs.length) * 100).toFixed(0);
      console.log(`    ${field.padEnd(45)} ${String(count).padStart(4)} propiedades (${pct}%)`);
    }
    console.log('');
  }

  if (results.matched_diffs.length > 0) {
    console.log('⚠️   PRIMERAS 20 DISCREPANCIAS:\n');
    for (const prop of results.matched_diffs.slice(0, 20)) {
      const tag = prop.method === 'id' ? '🔑' : '🔤';
      console.log(`  ${tag} "${prop.db_name}" (${prop.listing_id}) — ${prop.diff_count} diferencia(s):`);
      for (const d of prop.diffs) {
        console.log(`     • ${d.field}`);
        console.log(`       XLSX: ${JSON.stringify(d.xlsx_value)}`);
        console.log(`       DB  : ${JSON.stringify(d.db_value)}`);
      }
    }
    if (results.matched_diffs.length > 20) {
      console.log(`  … y ${results.matched_diffs.length - 20} más — ver CSV completo.\n`);
    }
  }

  // ── Aplicar updates ───────────────────────────────────────────────────────
  if (!IS_DRY_RUN && allDiscrepancies.length > 0) {
    console.log(`\n⚡  Aplicando ${allDiscrepancies.length} correcciones en DB...`);
    try {
      const { rows_updated, fields_updated } = await applyUpdates(pool, allDiscrepancies);
      console.log(`✅  ${rows_updated} propiedades actualizadas, ${fields_updated} campos corregidos.\n`);
    } catch (err) {
      console.error('❌  Error durante el UPDATE — ROLLBACK ejecutado:', err.message);
    }
  } else if (IS_DRY_RUN && allDiscrepancies.length > 0) {
    console.log(`\n🔍  DRY RUN — ${allDiscrepancies.length} correcciones pendientes.`);
    console.log(`    Para aplicarlas: node scripts/villanet-audit.js --update\n`);
  }

  await pool.end();

  // ── JSON ──────────────────────────────────────────────────────────────────
  const jsonPath = `${outBase}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify({
    ran_at:       new Date().toISOString(),
    dry_run:      IS_DRY_RUN,
    field_filter: FIELD_ONLY || null,
    threshold:    THRESHOLD,
    match_mode:   hasIdCol ? 'listing_id + fuzzy fallback' : 'fuzzy only',
    summary: {
      xlsx_rows:            xlsxRows.length,
      db_active_rows:       dbRows.length,
      matched_ok:           results.matched_ok.length,
      matched_diffs:        results.matched_diffs.length,
      no_match:             results.no_match.length,
      id_not_in_db:         results.id_not_in_db.length,
      total_discrepancies:  allDiscrepancies.length,
      unknown_xlsx_columns: unknownCols.length,
    },
    unknown_xlsx_columns: unknownCols,
    id_not_in_db:         results.id_not_in_db,
    matched_diffs:        results.matched_diffs,
    no_match:             results.no_match,
  }, null, 2));
  console.log(`📄  JSON → ${jsonPath}`);

  // ── CSV ───────────────────────────────────────────────────────────────────
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const csvLines = [
    '## DISCREPANCIAS — campos con valores distintos entre XLSX y DB',
    'listing_id,db_name,xlsx_name,match_method,similarity_pct,field,type,xlsx_value,db_value',
  ];

  for (const d of allDiscrepancies) {
    const simPct = d.method === 'id' ? '100% (id)' : `${(d.score * 100).toFixed(1)}%`;
    csvLines.push([
      esc(d.listing_id),
      esc(d.db_name),
      esc(d.xlsx_name),
      esc(d.method),
      simPct,
      esc(d.field),
      esc(d.type),
      esc(d.xlsx_value),
      esc(d.db_value),
    ].join(','));
  }

  if (results.id_not_in_db.length > 0) {
    csvLines.push('');
    csvLines.push('## ID EN XLSX NO ACTIVA EN DB — villanet_enabled=false o is_listed=false');
    csvLines.push('listing_id,xlsx_name,reason');
    for (const r of results.id_not_in_db) {
      csvLines.push([esc(r.listing_id), esc(r.xlsx_name), esc(r.reason)].join(','));
    }
  }

  csvLines.push('');
  csvLines.push('## SIN MATCH — sin listing_id y similitud < threshold');
  csvLines.push('listing_id,db_name,xlsx_name,match_method,similarity_pct,field,type,xlsx_value,db_value');
  for (const r of results.no_match) {
    const simPct = r.best_score != null ? `${(r.best_score * 100).toFixed(1)}%` : '';
    csvLines.push([
      '', esc(r.best_db_name), esc(r.xlsx_name), 'fuzzy', simPct,
      'NO_MATCH', '', '', '',
    ].join(','));
  }

  if (unknownCols.length > 0) {
    csvLines.push('');
    csvLines.push('## COLUMNAS NUEVAS EN XLSX — no existen en el esquema actual');
    csvLines.push('column_name');
    for (const col of unknownCols) csvLines.push(esc(col));
  }

  const csvPath = `${outBase}.csv`;
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`📄  CSV  → ${csvPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  process.exit(1);
});