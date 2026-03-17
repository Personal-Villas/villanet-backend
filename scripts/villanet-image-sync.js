#!/usr/bin/env node
/**
 * villanet-image-sync.js
 *
 * Lee las propiedades "matched_inactive" del reporte generado por
 * villanet-catalog-check.js, recupera sus imágenes desde la API de Guesty
 * y actualiza la DB:
 *
 *   - villanet_hero_images  → array JSON con las URLs (usado por PropertyCard)
 *   - images_json           → array JSON completo de imágenes
 *   - hero_image_url        → primera imagen como fallback
 *   - villanet_enabled      → true  (activa la propiedad en /properties)
 *
 * IMPORTANTE: Solo se activan propiedades que en Guesty figuren como
 * isListed = true AND isActive = true. Si una propiedad está desactivada
 * en Guesty, se reporta en "Pendientes Manuales" y NO se activa en DB,
 * para evitar que el URL Guardian la marque como falla.
 *
 * Si Guesty no devuelve imágenes para una propiedad, también se registra
 * en "Pendientes Manuales" y NO se activa.
 *
 * Uso:
 *   node scripts/villanet-image-sync.js --dry-run
 *   node scripts/villanet-image-sync.js
 *   node scripts/villanet-image-sync.js --report scripts/docs/villanet-report.json
 *
 * Archivos de referencia:
 *   Input : scripts/docs/villanet-report.json  (generado por villanet-catalog-check.js)
 *   Output: scripts/docs/villanet-sync-results.json
 *
 * Variables de entorno requeridas:
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 */

'use strict';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { Pool } from 'pg';
import { fetchListingById, extractImageUrlsFromListing } from '../src/services/guesty.service.js';
import { getGuestyAccessToken } from '../src/services/guestyAuth.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    report:    { type: 'string',  default: 'scripts/docs/villanet-report.json' },
    'dry-run': { type: 'boolean', default: false },
    help:      { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: node scripts/villanet-image-sync.js [options]

  --report    Path al JSON generado por villanet-catalog-check.js
              (default: scripts/docs/villanet-report.json)
  --dry-run   Simula el proceso sin escribir en la DB ni activar propiedades
  --help      Muestra este mensaje
`);
  process.exit(0);
}

const IS_DRY_RUN = args['dry-run'];

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

// ── Actualización en DB ───────────────────────────────────────────────────────
async function updateListingImages(listingId, imageUrls) {
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
  const outPath    = path.resolve('scripts/docs/villanet-sync-results.json');

  if (!fs.existsSync(reportPath)) {
    console.error(`❌  No se encontró el reporte: ${reportPath}`);
    console.error(`    Generalo primero con: node scripts/villanet-catalog-check.js`);
    process.exit(1);
  }

  const report   = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const inactive = report.matched_inactive ?? [];

  if (!inactive.length) {
    console.log('✅  No hay propiedades inactivas en el reporte. Nada que hacer.');
    await pool.end();
    return;
  }

  if (IS_DRY_RUN) console.log('⚠️   MODO DRY-RUN — no se escribirá nada en la DB\n');

  console.log(`\n🔄  Procesando ${inactive.length} propiedades matched_inactive...\n`);

  const guestyToken = await getGuestyAccessToken();

  const results = {
    activated:      [],   // ✅ Imágenes encontradas, activa en Guesty → habilitada en DB
    pending_manual: [],   // ⚠️ Sin imágenes o inactiva en Guesty → no se activa
    error:          [],   // ❌ Error de red u otro fallo
  };

  for (const prop of inactive) {
    const { listing_id, villanet_name, db_name } = prop;

    // Solo los IDs de 24 chars son MongoDB ObjectIds de Guesty.
    // Los de 32 chars son hashes internos — no se pueden fetchear.
    if (listing_id.length !== 24) {
      console.warn(`  ⚠️  ${villanet_name}: listing_id "${listing_id}" no es un ObjectId de Guesty (len=${listing_id.length}), saltando`);
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
      const guestyListing = await fetchListingById(guestyToken, listing_id);

      if (!guestyListing) {
        console.log('❌  No encontrado en Guesty');
        results.error.push({ listing_id, villanet_name, db_name, reason: 'Not found in Guesty API' });
        continue;
      }

      // Verificar que la propiedad esté activa y listada en Guesty.
      // Si no lo está, no la activamos en DB para evitar fallas en el URL Guardian.
      //
      // NOTA: La Guesty Open API v1 no devuelve un campo "isActive" en GET /listings/:id.
      // El campo correcto es "active" (boolean). Si tampoco existe, se considera activa
      // cuando isListed=true (criterio suficiente para mostrarse en /properties).
      const isListed = guestyListing.isListed ?? false;
      const isActive = guestyListing.active ?? guestyListing.isActive ?? isListed;

      if (!isListed || !isActive) {
        console.log(`⚠️  inactiva en Guesty (isListed=${isListed}, active=${isActive}) — omitida`);
        results.pending_manual.push({
          listing_id,
          villanet_name,
          db_name,
          reason: `Inactiva en Guesty (isListed=${isListed}, active=${isActive})`,
        });
        continue;
      }

      const imageUrls = extractImageUrlsFromListing(guestyListing);

      if (!imageUrls.length) {
        console.log('⚠️  sin imágenes en Guesty');
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
      results.activated.push({ listing_id, villanet_name, db_name, images_count: imageUrls.length });

    } catch (err) {
      console.log(`❌  Error: ${err.message}`);
      results.error.push({ listing_id, villanet_name, db_name, reason: err.message });
    }
  }

  await pool.end();

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`✅  Activadas exitosamente  : ${results.activated.length}`);
  console.log(`⚠️   Pendientes manuales     : ${results.pending_manual.length}`);
  console.log(`❌  Errores                 : ${results.error.length}`);
  console.log('══════════════════════════════════════════════════\n');

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

  // ── Guardar reporte ───────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    ran_at:  new Date().toISOString(),
    dry_run: IS_DRY_RUN,
    summary: {
      total_processed: inactive.length,
      activated:       results.activated.length,
      pending_manual:  results.pending_manual.length,
      errors:          results.error.length,
    },
    ...results,
  }, null, 2));
  console.log(`📄  Resultados → ${outPath}\n`);
}

main().catch(err => {
  console.error('❌  Error inesperado:', err);
  pool.end();
  process.exit(1);
});