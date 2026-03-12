#!/usr/bin/env node
/**
 * villanet-image-sync.js
 *
 * Lee las propiedades "matched_inactive" del reporte generado por
 * villanet-catalog-check.js, recupera sus imágenes desde la API de Guesty
 * y actualiza la DB:
 *
 *   - villanet_hero_images  → array JSON con las URLs (ya usado por PropertyCard)
 *   - images_json           → array JSON completo de imágenes
 *   - hero_image_url        → primera imagen como fallback
 *   - villanet_enabled      → true  (activa la propiedad en /properties)
 *
 * Si Guesty no devuelve imágenes para una propiedad, se registra en el log
 * de "Pendientes Manuales" y NO se activa.
 *
 * Uso:
 *   node scripts/villanet-image-sync.js \
 *     --report ../villanet-report.json \
 *     --dry-run              (opcional: simula sin escribir en DB)
 *
 * Variables de entorno requeridas (mismas que el resto del backend):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 *   (el token de Guesty lo maneja guestyOpenApiClient.js via getGuestyAccessToken)
 */

'use strict';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';

// Reutilizamos exactamente lo que ya existe en guesty.service.js
import { fetchListingById, extractImageUrlsFromListing } from '../src/services/guesty.service.js';

// Token de Guesty via el cliente autenticado existente
import { getGuestyAccessToken } from '../src/services/guestyAuth.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    report:  { type: 'string',  default: '../villanet-report.json' },
    'dry-run': { type: 'boolean', default: false },
    help:    { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-image-sync.js [options]

  --report    Path al JSON generado por villanet-catalog-check.js
              (default: ../villanet-report.json)
  --dry-run   Simula el proceso sin escribir en la DB ni activar propiedades
  --help      Muestra este mensaje
`);
  process.exit(0);
}

const IS_DRY_RUN = args['dry-run'];

// ── DB pool (misma config que db.js) ─────────────────────────────────────────
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

// ── Actualización en DB ───────────────────────────────────────────────────────
async function updateListingImages(listingId, imageUrls) {
  // Construimos el array de hero images en el mismo formato que usa PropertyCard.tsx
  // (mismo esquema que generó el backfill de PER-113)
  const heroImages = imageUrls.slice(0, 10).map((url, i) => ({
    url,
    order: i,
    source: 'guesty',
  }));

  await pool.query(`
    UPDATE listings SET
      villanet_hero_images = $1::jsonb,
      images_json          = $2::jsonb,
      hero_image_url       = $3,
      villanet_enabled     = true,
      updated_at           = NOW()
    WHERE listing_id = $4
  `, [
    JSON.stringify(heroImages),
    JSON.stringify(imageUrls),
    imageUrls[0],
    listingId,
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const reportPath = path.resolve(args.report);

  if (!fs.existsSync(reportPath)) {
    console.error(`❌  No se encontró el reporte: ${reportPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const inactive = report.matched_inactive ?? [];

  if (!inactive.length) {
    console.log('✅  No hay propiedades inactivas en el reporte. Nada que hacer.');
    await pool.end();
    return;
  }

  if (IS_DRY_RUN) console.log('⚠️   MODO DRY-RUN — no se escribirá nada en la DB\n');

  console.log(`\n🔄  Procesando ${inactive.length} propiedades matched_inactive...\n`);

  // Obtenemos el token una vez (guestyOpenApiClient lo cachea internamente,
  // pero fetchListingById de guesty.service.js lo recibe como argumento)
  const guestyToken = await getGuestyAccessToken();

  const results = {
    activated:        [],   // ✅ Imágenes encontradas y propiedad activada
    pending_manual:   [],   // ⚠️ Sin imágenes en Guesty — requiere acción manual
    error:            [],   // ❌ Error de red u otro fallo
  };

  for (const prop of inactive) {
    const { listing_id, villanet_name, db_name } = prop;

    // Los listing_ids de 24 chars son MongoDB ObjectIds de Guesty directamente.
    // Los de 32 chars son hashes internos — en ese caso no podemos hacer el fetch.
    if (listing_id.length !== 24) {
      console.warn(`  ⚠️  ${villanet_name}: listing_id "${listing_id}" no es un ID de Guesty (len=${listing_id.length}), saltando`);
      results.pending_manual.push({
        listing_id,
        villanet_name,
        db_name,
        reason: 'listing_id no es un ObjectId de Guesty (32 chars)',
      });
      continue;
    }

    process.stdout.write(`  🔍  ${villanet_name} (${listing_id})... `);

    try {
      // Reutilizamos fetchListingById de guesty.service.js
      const guestyListing = await fetchListingById(guestyToken, listing_id);

      if (!guestyListing) {
        console.log('❌  No encontrado en Guesty');
        results.error.push({ listing_id, villanet_name, db_name, reason: 'Not found in Guesty API' });
        continue;
      }

      // Reutilizamos extractImageUrlsFromListing de guesty.service.js
      const imageUrls = extractImageUrlsFromListing(guestyListing);

      if (!imageUrls.length) {
        console.log('⚠️  Sin imágenes');
        results.pending_manual.push({
          listing_id,
          villanet_name,
          db_name,
          reason: 'Guesty no devolvió imágenes para esta propiedad',
        });
        continue;
      }

      if (!IS_DRY_RUN) {
        await updateListingImages(listing_id, imageUrls);
      }

      console.log(`✅  ${imageUrls.length} imágenes${IS_DRY_RUN ? ' (dry-run)' : ' → DB actualizada'}`);
      results.activated.push({
        listing_id,
        villanet_name,
        db_name,
        images_count: imageUrls.length,
      });

    } catch (err) {
      console.log(`❌  Error: ${err.message}`);
      results.error.push({
        listing_id,
        villanet_name,
        db_name,
        reason: err.message,
      });
    }
  }

  await pool.end();

  // ── Resumen en consola ────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`✅  Activadas exitosamente  : ${results.activated.length}`);
  console.log(`⚠️   Pendientes manuales     : ${results.pending_manual.length}`);
  console.log(`❌  Errores                 : ${results.error.length}`);
  console.log('══════════════════════════════════════════════════\n');

  // ── Log de pendientes manuales ────────────────────────────────────────────
  if (results.pending_manual.length) {
    console.log('⚠️   PENDIENTES MANUALES:');
    for (const p of results.pending_manual)
      console.log(`    • ${p.villanet_name} (${p.listing_id}) — ${p.reason}`);
    console.log('');
  }

  if (results.error.length) {
    console.log('❌  ERRORES:');
    for (const e of results.error)
      console.log(`    • ${e.villanet_name} (${e.listing_id}) — ${e.reason}`);
    console.log('');
  }

  // ── JSON con resultados completos ─────────────────────────────────────────
  const outPath = path.resolve('../villanet-sync-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ran_at:    new Date().toISOString(),
    dry_run:   IS_DRY_RUN,
    summary: {
      total_processed: inactive.length,
      activated:       results.activated.length,
      pending_manual:  results.pending_manual.length,
      errors:          results.error.length,
    },
    ...results,
  }, null, 2));
  console.log(`📄  Resultados completos → ${outPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  pool.end();
  process.exit(1);
});