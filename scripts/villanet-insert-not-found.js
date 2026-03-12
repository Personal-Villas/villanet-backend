#!/usr/bin/env node
/**
 * villanet-insert-not-found.js
 *
 * Inserta en la tabla listings las propiedades "not_found" del catálogo PO
 * que existen en Guesty pero no están en nuestra DB.
 *
 * Opera en dos modos:
 *   1. IDs conocidos  → fetchea el listing de Guesty directamente por ID
 *   2. Búsqueda por nombre → busca en Guesty por nombre y selecciona el match
 *
 * Para cada listing encontrado:
 *   - Verifica que no exista ya en DB (idempotente)
 *   - Inserta con villanet_enabled = true y villanet_hero_images desde Guesty
 *
 * Uso:
 *   node scripts/villanet-insert-not-found.js --dry-run
 *   node scripts/villanet-insert-not-found.js
 *   node scripts/villanet-insert-not-found.js --list ../not-found-insert-list.json
 */

'use strict';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';
import { getGuestyAccessToken } from '../src/services/guestyAuth.js';
import { fetchListingById, extractImageUrlsFromListing } from '../src/services/guesty.service.js';
import axios from 'axios';

const { values: args } = parseArgs({
  options: {
    list:      { type: 'string',  default: '../not-found-insert-list.json' },
    'dry-run': { type: 'boolean', default: false },
    help:      { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-insert-not-found.js [options]

  --list      Path al JSON con la lista de IDs/nombres  (default: ../not-found-insert-list.json)
  --dry-run   Muestra qué haría sin escribir en la DB
  --help      Muestra este mensaje
`);
  process.exit(0);
}

const IS_DRY_RUN = args['dry-run'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── Buscar listing en Guesty por nombre ───────────────────────────────────────
async function searchGuestyByName(api, name) {
  try {
    const { data } = await api.get('/listings', {
      params: { limit: 10, q: name, filters: JSON.stringify([{ field: 'active', operator: '$eq', value: true }]) },
    });
    return data?.results ?? [];
  } catch (e) {
    // Fallback sin filtros si la API no los soporta
    try {
      const { data } = await api.get('/listings', { params: { limit: 25, q: name } });
      return data?.results ?? [];
    } catch {
      return [];
    }
  }
}

// ── Construir villanet_hero_images desde listing de Guesty ────────────────────
function buildHeroImages(listing) {
  let urls = [];
  try {
    urls = extractImageUrlsFromListing(listing);
  } catch {
    // Fallback manual si extractImageUrlsFromListing no existe o falla
    const pics = listing?.pictures || listing?.images || [];
    urls = pics.map(p => p?.original || p?.large || p?.regular || p?.url).filter(Boolean);
  }
  return urls.slice(0, 10).map((url, i) => ({ url, order: i, source: 'guesty' }));
}

// ── Extraer campos del listing de Guesty para INSERT ─────────────────────────
function extractListingFields(listing) {
  const addr = listing?.address || {};
  const prices = listing?.prices || listing?.pricingSettings || {};

  let price = null;
  if (listing?.prices?.basePrice)              price = Number(listing.prices.basePrice);
  else if (listing?.pricingSettings?.basePrice) price = Number(listing.pricingSettings.basePrice);

  let heroImage = null;
  if (listing?.picture) heroImage = listing.picture.large || listing.picture.original || null;
  if (!heroImage && listing?.pictures?.[0]) heroImage = listing.pictures[0].large || listing.pictures[0].original || null;

  let imagesJson = [];
  try {
    const pics = listing?.pictures || listing?.images || [];
    imagesJson = pics.map(p => p?.original || p?.large || p?.regular || p?.url).filter(Boolean);
  } catch {}

  return {
    listing_id:        listing._id || listing.id,
    name:              listing.nickname || listing.title || listing.name || '',
    bedrooms:          listing?.bedrooms ?? null,
    bathrooms:         listing?.bathrooms ?? null,
    price_usd:         price,
    city:              addr.city || addr.neighbourhood || null,
    country:           addr.country || addr.countryCode || null,
    location_text:     addr.full || [addr.city, addr.country].filter(Boolean).join(', ') || null,
    min_nights: listing?.terms?.minNights ?? listing?.defaultOccupancy?.minNights ?? null,
    is_listed:         listing?.isListed ?? false,
    hero_image_url:    heroImage,
    images_json:       JSON.stringify(imagesJson),
    description:       listing?.publicDescription?.summary || listing?.description || null,
    max_guests:        listing?.accommodates ?? null,
    lat:               listing?.address?.lat ?? listing?.address?.latitude ?? null,
    lng:               listing?.address?.lng ?? listing?.address?.longitude ?? null,
  };
}

// ── INSERT en DB ──────────────────────────────────────────────────────────────
async function insertListing(fields, heroImages) {
  await pool.query(`
    INSERT INTO listings (
      listing_id, name, bedrooms, bathrooms, price_usd,
      city, country, location_text, min_nights, is_listed,
      hero_image_url, images_json, description, max_guests, lat, lng,
      has_detail, villanet_hero_images, villanet_enabled, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16,
      false, $17, true, NOW()
    )
    ON CONFLICT (listing_id) DO NOTHING
  `, [
    fields.listing_id, fields.name, fields.bedrooms, fields.bathrooms, fields.price_usd,
    fields.city, fields.country, fields.location_text, fields.min_nights, fields.is_listed,
    fields.hero_image_url, fields.images_json, fields.description, fields.max_guests, fields.lat, fields.lng,
    JSON.stringify(heroImages),
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const listPath = path.resolve(args.list);
  if (!fs.existsSync(listPath)) {
    console.error(`❌  No se encontró: ${listPath}`);
    process.exit(1);
  }

  const { known_ids, search_by_name } = JSON.parse(fs.readFileSync(listPath, 'utf8'));

  if (IS_DRY_RUN) console.log('⚠️   MODO DRY-RUN — no se escribirá nada en la DB\n');

  // Traer IDs existentes en DB para chequeo idempotente
  const { rows: existingRows } = await pool.query('SELECT listing_id FROM listings');
  const existingIds = new Set(existingRows.map(r => r.listing_id));

  const token = await getGuestyAccessToken();
  const api = axios.create({
    baseURL: 'https://open-api.guesty.com/v1',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });

  const results = { inserted: [], skipped: [], error: [], needs_manual: [] };

  // ── Fase 1: IDs conocidos ─────────────────────────────────────────────────
  console.log(`\n📋  FASE 1 — IDs conocidos (${known_ids.length})\n`);

  for (const item of known_ids) {
    process.stdout.write(`  📡  ${item.name} (${item.guesty_id})... `);

    if (existingIds.has(item.guesty_id)) {
      console.log('⏭️   ya existe en DB');
      results.skipped.push({ ...item, reason: 'ya existe en DB' });
      continue;
    }

    let listing;
    try {
      listing = await fetchListingById(token, item.guesty_id);
      await sleep(200);
    } catch (e) {
      console.log(`❌  Guesty error: ${e.message}`);
      results.error.push({ ...item, reason: e.message });
      continue;
    }

    if (!listing) {
      console.log('❌  No encontrado en Guesty');
      results.error.push({ ...item, reason: 'not found in Guesty' });
      continue;
    }

    const fields     = extractListingFields(listing);
    const heroImages = buildHeroImages(listing);

    if (!IS_DRY_RUN) {
      try {
        await insertListing(fields, heroImages);
      } catch (e) {
        console.log(`❌  DB error: ${e.message}`);
        results.error.push({ ...item, reason: e.message });
        continue;
      }
    }

    console.log(`✅  ${IS_DRY_RUN ? '(dry-run) ' : ''}insertado — ${heroImages.length} imágenes`);
    results.inserted.push({ listing_id: fields.listing_id, name: fields.name, destination: item.destination });
  }

  // ── Fase 2: Búsqueda por nombre ───────────────────────────────────────────
  console.log(`\n📋  FASE 2 — Búsqueda por nombre (${search_by_name.length})\n`);

  for (const item of search_by_name) {
    process.stdout.write(`  🔍  "${item.name}" [${item.destination}]... `);

    let candidates;
    try {
      candidates = await searchGuestyByName(api, item.name);
      await sleep(300);
    } catch (e) {
      console.log(`❌  Guesty search error: ${e.message}`);
      results.error.push({ ...item, reason: e.message });
      continue;
    }

    // Filtrar activos y listed
    const active = candidates.filter(l => (l.isListed ?? true) && (l.isActive ?? true));

    if (!active.length) {
      console.log(`⚠️   no encontrado en Guesty — requiere revisión manual`);
      results.needs_manual.push({ ...item, reason: 'no encontrado en búsqueda Guesty' });
      continue;
    }

    // Si hay uno solo, insertar. Si hay varios, registrar para revisión.
    if (active.length > 1) {
      const names = active.map(l => `"${l.nickname || l.name}" (${l._id})`).join(', ');
      console.log(`⚠️   ${active.length} candidatos → revisión manual: ${names}`);
      results.needs_manual.push({ ...item, candidates: active.map(l => ({ id: l._id, name: l.nickname || l.name })) });
      continue;
    }

    const listing = active[0];
    const gid = listing._id || listing.id;

    if (existingIds.has(gid)) {
      console.log(`⏭️   ya existe en DB como "${listing.nickname || listing.name}"`);
      results.skipped.push({ ...item, reason: `ya existe en DB como "${listing.nickname || listing.name}"` });
      continue;
    }

    const fields     = extractListingFields(listing);
    const heroImages = buildHeroImages(listing);

    if (!IS_DRY_RUN) {
      try {
        await insertListing(fields, heroImages);
      } catch (e) {
        console.log(`❌  DB error: ${e.message}`);
        results.error.push({ ...item, reason: e.message });
        continue;
      }
    }

    console.log(`✅  ${IS_DRY_RUN ? '(dry-run) ' : ''}insertado como "${fields.name}" — ${heroImages.length} imágenes`);
    results.inserted.push({ listing_id: fields.listing_id, name: fields.name, destination: item.destination });
  }

  // ── Resumen final ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('RESUMEN FINAL');
  console.log('═'.repeat(60));
  console.log(`  ✅  Insertados       : ${results.inserted.length}`);
  console.log(`  ⏭️   Skipped (ya en DB): ${results.skipped.length}`);
  console.log(`  ⚠️   Revisión manual  : ${results.needs_manual.length}`);
  console.log(`  ❌  Errores          : ${results.error.length}`);

  if (results.inserted.length) {
    console.log('\n  Insertados:');
    for (const r of results.inserted) console.log(`    - [${r.destination}] ${r.name} (${r.listing_id})`);
  }

  if (results.needs_manual.length) {
    console.log('\n  Requieren revisión manual:');
    for (const r of results.needs_manual) {
      if (r.candidates) {
        console.log(`    - "${r.name}" [${r.destination}]: múltiples candidatos:`);
        for (const c of r.candidates) console.log(`        • "${c.name}" (${c.id})`);
      } else {
        console.log(`    - "${r.name}" [${r.destination}]: ${r.reason}`);
      }
    }
  }

  if (results.error.length) {
    console.log('\n  Errores:');
    for (const r of results.error) console.log(`    - "${r.name || r.guesty_id}": ${r.reason}`);
  }

  // Guardar reporte JSON
  const reportPath = '../villanet-insert-not-found-report.json';
  fs.writeFileSync(reportPath, JSON.stringify({ ...results, dry_run: IS_DRY_RUN, ts: new Date().toISOString() }, null, 2));
  console.log(`\n  📄  Reporte guardado en ${reportPath}`);

  await pool.end();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});