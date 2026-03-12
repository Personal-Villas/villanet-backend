#!/usr/bin/env node
/**
 * villanet-guesty-exhaustive-check.js
 *
 * Trae TODOS los listings de Guesty (~2549), los agrupa por nombre base,
 * cruza contra la DB y reporta qué variantes faltan agregar.
 *
 * Lógica de agrupamiento:
 *   "Cornucopia 1BR Suite", "Cornucopia 5BR", "Cornucopia Sea Views"
 *   → grupo base "Cornucopia"
 *
 * Output CSV con una fila por variante de Guesty:
 *   - IN_DB_ACTIVE      → existe en DB y villanet_enabled=true
 *   - IN_DB_INACTIVE    → existe en DB pero villanet_enabled=false
 *   - MISSING_INSERT    → no está en DB, activa en Guesty → hay que agregar
 *   - SKIP_INACTIVE     → no está en DB, inactiva/unlisted en Guesty → ignorar
 *
 * Uso:
 *   node scripts/villanet-guesty-exhaustive-check.js
 *   node scripts/villanet-guesty-exhaustive-check.js --out ../mi-reporte
 */

'use strict';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';
import axios from 'axios';
import { getGuestyAccessToken } from '../src/services/guestyAuth.js';

// ── fetchAllListingsSkip — paginación real de Guesty Open API ─────────────────
// La API devuelve { results, limit, skip, count } — no usa cursor sino skip.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllListingsSkip(token, limit = 100) {
  const api = axios.create({
    baseURL: 'https://open-api.guesty.com/v1',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });

  const first = await api.get('/listings', { params: { limit, skip: 0 } });
  const total = first.data?.count ?? 0;
  const results = [...(first.data?.results ?? [])];

  console.log(`   Total en Guesty: ${total} — descargando en chunks de ${limit}...`);

  let skip = limit;
  while (skip < total) {
    process.stdout.write(`   Progreso: ${Math.min(skip + limit, total)}/${total} listings...\r`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const { data } = await api.get('/listings', { params: { limit, skip } });
        results.push(...(data?.results ?? []));
        break;
      } catch (e) {
        if (e?.response?.status === 429 && attempt < 5) {
          const wait = parseInt(e.response.headers?.['retry-after'] || '2', 10) * 1000;
          await sleep(wait);
        } else throw e;
      }
    }
    skip += limit;
    await sleep(150);
  }
  process.stdout.write('\n');
  return results;
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    out:  { type: 'string',  default: '../villanet-guesty-exhaustive' },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-guesty-exhaustive-check.js [options]

  --out   Path prefix para los archivos de output  (default: ../villanet-guesty-exhaustive)
  --help  Muestra este mensaje
`);
  process.exit(0);
}

// ── DB pool ───────────────────────────────────────────────────────────────────
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

// ── Extractor de nombre base (validado contra casos reales) ───────────────────
function extractBase(name) {
  let s = (name || '').trim();
  s = s.replace(/\s*[-–]?\s*\(?\d+\s*BR\b\)?.*$/i, '');
  s = s.replace(/\s*[-–]?\s*\d+\s*pax\b.*$/i, '');
  s = s.replace(/\s+(Suite|Cottage|Garden\s+V?|Sea\s+Views?)\s*$/i, '');
  return s.trim();
}

// ── Normalizar para comparación (igual que villanet-catalog-check) ────────────
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\bvilla\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const outBase = path.resolve(args.out);

  console.log('\n📂  Conectando a DB y Guesty...');

  // Cargar DB
  const { rows: dbRows } = await pool.query(`
    SELECT listing_id, name, villanet_enabled
    FROM listings
    ORDER BY name
  `);
  await pool.end();
  console.log(`✅  DB listings       : ${dbRows.length} filas`);

  // Cargar Guesty
  const guestyToken = await getGuestyAccessToken();
  console.log('🔄  Descargando todos los listings de Guesty (puede tardar ~2-3 min)...');
  const guestyListings = await fetchAllListingsSkip(guestyToken, 100);
  console.log(`✅  Guesty listings   : ${guestyListings.length} obtenidos\n`);

  // ── Indexar DB por listing_id y por nombre normalizado ────────────────────
  const dbById   = new Map(dbRows.map(r => [r.listing_id, r]));
  const dbByNorm = new Map(dbRows.map(r => [normalize(r.name), r]));

  // ── Agrupar Guesty por nombre base ────────────────────────────────────────
  // Mapa: base_normalizado → [ ...listings de Guesty ]
  const guestyGroups = new Map();

  for (const listing of guestyListings) {
    const rawName = listing.nickname || listing.title || listing.name || '';
    if (!rawName) continue;

    const base     = extractBase(rawName);
    const baseNorm = normalize(base);
    if (!baseNorm) continue;

    if (!guestyGroups.has(baseNorm)) guestyGroups.set(baseNorm, []);
    guestyGroups.get(baseNorm).push(listing);
  }

  // Solo nos interesan grupos con MÁS de una variante en Guesty
  // (los únicos son candidatos directos, se manejan por otro flujo)
  const multiGroups = [...guestyGroups.entries()]
    .filter(([, listings]) => listings.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  console.log(`🔍  Grupos con múltiples variantes en Guesty : ${multiGroups.length}`);

  // ── Procesar cada variante ────────────────────────────────────────────────
  const results = [];

  for (const [baseNorm, variants] of multiGroups) {
    const baseName = extractBase(variants[0].nickname || variants[0].title || variants[0].name || '');

    for (const listing of variants) {
      const guestyId  = listing._id || listing.id;
      const fullName  = listing.nickname || listing.title || listing.name || '';
      const isListed  = listing.isListed ?? listing.listed  ?? false;
      const isActive  = listing.isActive ?? listing.active  ?? true;

      const addr      = listing.address || {};
      const city      = addr.city || addr.neighbourhood || '';
      const country   = addr.country || addr.countryCode || '';

      // ¿Está en DB? Buscar por ID primero, luego por nombre normalizado
      const dbMatch   = dbById.get(guestyId) || dbByNorm.get(normalize(fullName)) || null;
      const inDb      = !!dbMatch;

      let action;
      if (inDb) {
        action = dbMatch.villanet_enabled ? 'IN_DB_ACTIVE' : 'IN_DB_INACTIVE';
      } else if (!isListed || !isActive) {
        action = 'SKIP_INACTIVE';
      } else {
        action = 'MISSING_INSERT';
      }

      results.push({
        base_name:        baseName,
        guesty_full_name: fullName,
        guesty_id:        guestyId,
        guesty_city:      city,
        guesty_country:   country,
        is_listed:        isListed,
        is_active:        isActive,
        in_db:            inDb,
        db_listing_id:    dbMatch?.listing_id || '',
        db_name:          dbMatch?.name || '',
        villanet_enabled: dbMatch?.villanet_enabled ?? '',
        action,
      });
    }
  }

  // ── Resumen ───────────────────────────────────────────────────────────────
  const count = (action) => results.filter(r => r.action === action).length;
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`✅  IN_DB_ACTIVE    (en DB, activa)         : ${count('IN_DB_ACTIVE')}`);
  console.log(`⚠️   IN_DB_INACTIVE  (en DB, desactivada)    : ${count('IN_DB_INACTIVE')}`);
  console.log(`🆕  MISSING_INSERT  (falta agregar)          : ${count('MISSING_INSERT')}`);
  console.log(`⏭️   SKIP_INACTIVE   (inactiva en Guesty)    : ${count('SKIP_INACTIVE')}`);
  console.log('══════════════════════════════════════════════════════\n');

  // Mostrar preview de las que faltan
  const missing = results.filter(r => r.action === 'MISSING_INSERT');
  if (missing.length) {
    console.log(`🆕  Primeras 10 variantes para INSERT:`);
    for (const r of missing.slice(0, 10))
      console.log(`    • [${r.base_name}] → "${r.guesty_full_name}" | ${r.guesty_city}, ${r.guesty_country}`);
    if (missing.length > 10) console.log(`    … y ${missing.length - 10} más (ver CSV)`);
    console.log('');
  }

  // ── CSV output ────────────────────────────────────────────────────────────
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = [
    'action', 'base_name', 'guesty_full_name', 'guesty_id',
    'guesty_city', 'guesty_country', 'is_listed', 'is_active',
    'in_db', 'db_listing_id', 'db_name', 'villanet_enabled',
  ];
  const csvLines = [headers.join(',')];

  // Ordenar: MISSING_INSERT primero, luego IN_DB_INACTIVE, luego el resto
  const order = { MISSING_INSERT: 0, IN_DB_INACTIVE: 1, IN_DB_ACTIVE: 2, SKIP_INACTIVE: 3 };
  results.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9) || a.base_name.localeCompare(b.base_name));

  for (const r of results)
    csvLines.push(headers.map(h => esc(r[h])).join(','));

  const csvPath = `${outBase}.csv`;
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // ── JSON output ───────────────────────────────────────────────────────────
  const jsonPath = `${outBase}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify({
    ran_at:  new Date().toISOString(),
    summary: {
      groups_with_variants: multiGroups.length,
      IN_DB_ACTIVE:         count('IN_DB_ACTIVE'),
      IN_DB_INACTIVE:       count('IN_DB_INACTIVE'),
      MISSING_INSERT:       count('MISSING_INSERT'),
      SKIP_INACTIVE:        count('SKIP_INACTIVE'),
    },
    results,
  }, null, 2));

  console.log(`📄  CSV  → ${csvPath}`);
  console.log(`📄  JSON → ${jsonPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  pool.end();
  process.exit(1);
});