#!/usr/bin/env node
/**
 * backfill-listing-details.js
 *
 * Rellena campos faltantes (bedrooms, bathrooms, max_guests, min_nights,
 * price_usd, location_text, lat, lng) en listings activas de la DB
 * consultando la API de Guesty.
 *
 * Es IDEMPOTENTE: solo toca filas donde al menos uno de los campos
 * objetivo está NULL. Si ya están todos completos, no hace nada.
 *
 * Uso:
 *   node scripts/backfill-listing-details.js            → dry-run (muestra qué haría)
 *   node scripts/backfill-listing-details.js --apply    → aplica los cambios en DB
 *   node scripts/backfill-listing-details.js --apply --all   → re-sincroniza TODAS las activas
 *   node scripts/backfill-listing-details.js --id <listing_id>  → una sola propiedad
 *
 * Output:
 *   scripts/docs/backfill-listing-details-YYYY-MM-DD.json
 *
 * Requiere: npm install dotenv pg
 */

'use strict';

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';
import { fetchListingById }  from '../src/services/guesty.service.js';
import { getGuestyAccessToken } from '../src/services/guestyAuth.js';

// ── CLI ───────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    apply:   { type: 'boolean', default: false },
    all:     { type: 'boolean', default: false },   // re-sync aunque ya tengan datos
    id:      { type: 'string',  default: '' },       // una sola propiedad
    out:     { type: 'string',  default: 'scripts/docs/backfill-listing-details' },
    help:    { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/backfill-listing-details.js [options]

  (sin flags)     Dry-run: muestra qué campos se rellenarían, sin escribir en DB
  --apply         Aplica los cambios en DB
  --all           Re-sincroniza TODAS las activas (no solo las que tienen NULLs)
  --id <id>       Opera solo sobre una listing_id específica
  --out <prefix>  Prefijo para el JSON de reporte  (default: scripts/docs/backfill-listing-details)
  --help          Muestra este mensaje
`);
  process.exit(0);
}

const IS_DRY_RUN  = !args.apply;
const RESYNC_ALL  = args.all;
const SINGLE_ID   = args.id?.trim() || null;

// Campos que este script puede rellenar (en orden de prioridad visual)
const TRACKED_FIELDS = ['bedrooms', 'bathrooms', 'max_guests', 'min_nights', 'price_usd', 'location_text', 'lat', 'lng'];

const BATCH_SIZE  = 10;   // Conservador: cada llamada a Guesty trae el listing completo
const PAUSE_MS    = 1500; // 1.5s entre batches para no saturar la API

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── DB ────────────────────────────────────────────────────────────────────────
// Elevar el timeout de conexión de pg para que getGuestyAccessToken
// (que usa src/db.js con su propio pool) no corte antes de tiempo.
process.env.PGCONNECT_TIMEOUT = '120';

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
  idleTimeoutMillis:       1000000,
});

// ── Extraer campos desde el listing de Guesty ─────────────────────────────────
function extractFields(listing) {
  const addr = listing?.address || {};

  let price = null;
  if (listing?.prices?.basePrice)              price = Number(listing.prices.basePrice);
  else if (listing?.pricingSettings?.basePrice) price = Number(listing.pricingSettings.basePrice);

  const lat = listing?.address?.lat ?? listing?.address?.latitude  ?? null;
  const lng = listing?.address?.lng ?? listing?.address?.longitude ?? null;

  const locationParts = [
    addr.city || addr.neighbourhood,
    addr.country || addr.countryCode,
  ].filter(Boolean);

  return {
    bedrooms:      listing?.bedrooms      ?? null,
    bathrooms:     listing?.bathrooms     ?? null,
    max_guests:    listing?.accommodates  ?? null,
    min_nights:    listing?.terms?.minNights
                ?? listing?.defaultOccupancy?.minNights
                ?? null,
    price_usd:     price,
    location_text: addr.full || locationParts.join(', ') || null,
    lat:           lat != null ? parseFloat(lat) : null,
    lng:           lng != null ? parseFloat(lng) : null,
  };
}

// ── UPDATE en DB — solo los campos que llegaron con valor ─────────────────────
async function updateListing(listingId, fields) {
  // Solo actualiza campos que Guesty devolvió con valor no nulo
  const setClauses = [];
  const values     = [];

  for (const [col, val] of Object.entries(fields)) {
    if (val !== null && val !== undefined) {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    }
  }

  if (!setClauses.length) return 0; // nada que actualizar

  values.push(listingId);
  const { rowCount } = await pool.query(
    `UPDATE listings SET ${setClauses.join(', ')}, updated_at = NOW()
     WHERE listing_id = $${values.length}`,
    values
  );
  return rowCount;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = path.resolve(`${args.out}-${dateStr}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Backfill — Detalles de listings (bedrooms, bathrooms, etc.)');
  console.log(` Modo: ${IS_DRY_RUN ? '🔍 DRY-RUN (sin cambios en DB)' : '⚡ APPLY (escribe en DB)'}`);
  if (RESYNC_ALL) console.log(' ⚡  --all: re-sincroniza aunque ya tengan datos');
  if (SINGLE_ID)  console.log(` 🎯  --id: solo ${SINGLE_ID}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Auth Guesty — primero, antes de tocar la DB ─────────────────────────────
  // getGuestyAccessToken puede usar src/db.js internamente (pool separado).
  // Obtenerlo primero evita que compita con las queries siguientes.
  console.log('🔑  Obteniendo token de Guesty...');
  let token;
  try {
    token = await getGuestyAccessToken();
    console.log('✅  Token OK\n');
  } catch (err) {
    console.error('❌  No se pudo obtener el token de Guesty:', err.message);
    console.error('    Verificá que GUESTY_CLIENT_ID y GUESTY_CLIENT_SECRET estén en el .env');
    console.error('    y que haya conectividad a open-api.guesty.com desde esta máquina.');
    await pool.end();
    process.exit(1);
  }

  // ── Cargar listings a procesar ──────────────────────────────────────────────
  let listings;
  if (SINGLE_ID) {
    const { rows } = await pool.query(
      `SELECT listing_id, name FROM listings WHERE listing_id = $1`,
      [SINGLE_ID]
    );
    listings = rows;
  } else if (RESYNC_ALL) {
    const { rows } = await pool.query(
      `SELECT listing_id, name FROM listings
       WHERE villanet_enabled = true AND is_listed = true
       ORDER BY name`
    );
    listings = rows;
  } else {
    // Default: solo los que tienen al menos un campo NULL
    const nullChecks = TRACKED_FIELDS.map(f => `${f} IS NULL`).join(' OR ');
    const { rows } = await pool.query(
      `SELECT listing_id, name,
              bedrooms, bathrooms, max_guests, min_nights,
              price_usd, location_text, lat, lng
       FROM listings
       WHERE villanet_enabled = true
         AND is_listed = true
         AND (${nullChecks})
       ORDER BY name`
    );
    listings = rows;
  }

  if (!listings.length) {
    console.log('✅  No hay propiedades con campos faltantes. Nada que hacer.');
    await pool.end();
    return;
  }

  console.log(`📊  Propiedades a procesar: ${listings.length}`);
  if (!RESYNC_ALL && !SINGLE_ID) {
    // Mostrar cuántas tienen cada campo nulo
    const nullCounts = {};
    for (const f of TRACKED_FIELDS) nullCounts[f] = 0;
    for (const r of listings) {
      for (const f of TRACKED_FIELDS) {
        if (r[f] === null || r[f] === undefined) nullCounts[f]++;
      }
    }
    console.log('\n   Campos nulos por campo:');
    for (const [f, count] of Object.entries(nullCounts)) {
      if (count > 0) console.log(`     ${f.padEnd(16)}: ${count}`);
    }
    console.log('');
  }

  // ── Procesar en batches ─────────────────────────────────────────────────────
  const results = {
    updated:       [],
    no_change:     [],
    not_in_guesty: [],
    error:         [],
  };

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch       = listings.slice(i, i + BATCH_SIZE);
    const batchNum    = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(listings.length / BATCH_SIZE);

    console.log(`📦  Batch ${batchNum}/${totalBatches} (${batch.length} props)...`);

    await Promise.allSettled(batch.map(async (row) => {
      const { listing_id, name } = row;
      process.stdout.write(`   ${name || listing_id}... `);

      try {
        const guestyListing = await fetchListingById(token, listing_id);

        if (!guestyListing) {
          console.log('⚠️  no encontrado en Guesty');
          results.not_in_guesty.push({ listing_id, name });
          return;
        }

        const fetched = extractFields(guestyListing);

        // Qué campos se van a actualizar (tienen valor en Guesty y eran null en DB o --all)
        const toUpdate = {};
        const nullsBefore = [];
        const willFill    = [];
        const stillNull   = [];

        for (const f of TRACKED_FIELDS) {
          const dbVal      = row[f];
          const guestyVal  = fetched[f];
          const isNull     = dbVal === null || dbVal === undefined;

          if (isNull) nullsBefore.push(f);

          if ((isNull || RESYNC_ALL) && guestyVal !== null && guestyVal !== undefined) {
            toUpdate[f] = guestyVal;
            willFill.push(`${f}=${guestyVal}`);
          } else if (isNull && (guestyVal === null || guestyVal === undefined)) {
            stillNull.push(f);
          }
        }

        if (!Object.keys(toUpdate).length) {
          console.log('— sin cambios (Guesty tampoco tiene datos)');
          results.no_change.push({ listing_id, name, still_null: stillNull });
          return;
        }

        if (!IS_DRY_RUN) {
          await updateListing(listing_id, toUpdate);
        }

        const tag = IS_DRY_RUN ? '[dry]' : '✅';
        console.log(`${tag} ${willFill.join(', ')}`);
        results.updated.push({
          listing_id,
          name,
          fields_updated: Object.keys(toUpdate),
          values:         toUpdate,
          still_null:     stillNull,
        });

      } catch (err) {
        console.log(`❌  ${err.message}`);
        results.error.push({ listing_id, name, error: err.message });
      }
    }));

    if (i + BATCH_SIZE < listings.length) await sleep(PAUSE_MS);
  }

  await pool.end();

  // ── Resumen ─────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`✅  Actualizadas          : ${results.updated.length}`);
  console.log(`—   Sin cambios (nulos en Guesty): ${results.no_change.length}`);
  console.log(`⚠️   No encontradas en Guesty: ${results.not_in_guesty.length}`);
  console.log(`❌  Errores               : ${results.error.length}`);
  console.log('─'.repeat(60));

  if (IS_DRY_RUN && results.updated.length > 0) {
    console.log(`\n🔍  DRY-RUN — para aplicar: node scripts/backfill-listing-details.js --apply\n`);
  }

  // Mostrar qué campos quedan nulos después del run
  const remainingNull = {};
  for (const r of [...results.no_change, ...results.updated]) {
    for (const f of (r.still_null || [])) {
      remainingNull[f] = (remainingNull[f] || 0) + 1;
    }
  }
  if (Object.keys(remainingNull).length > 0) {
    console.log('\n⚠️   Campos que Guesty tampoco tiene (quedan nulos):');
    for (const [f, count] of Object.entries(remainingNull)) {
      console.log(`    ${f.padEnd(16)}: ${count} propiedad(es)`);
    }
  }

  if (results.not_in_guesty.length > 0) {
    console.log('\n⚠️   No encontradas en Guesty:');
    for (const r of results.not_in_guesty) {
      console.log(`    • ${r.name} (${r.listing_id})`);
    }
  }

  if (results.error.length > 0) {
    console.log('\n❌  Errores:');
    for (const r of results.error) {
      console.log(`    • ${r.name} (${r.listing_id}): ${r.error}`);
    }
  }

  // ── Guardar reporte ─────────────────────────────────────────────────────────
  fs.writeFileSync(outPath, JSON.stringify({
    ran_at:   new Date().toISOString(),
    dry_run:  IS_DRY_RUN,
    resync_all: RESYNC_ALL,
    summary: {
      total:         listings.length,
      updated:       results.updated.length,
      no_change:     results.no_change.length,
      not_in_guesty: results.not_in_guesty.length,
      errors:        results.error.length,
    },
    remaining_nulls_in_guesty: remainingNull,
    ...results,
  }, null, 2));
  console.log(`\n📄  Reporte → ${outPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  pool.end();
  process.exit(1);
});