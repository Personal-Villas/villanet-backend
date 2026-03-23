// scripts/backfill-hero-images.js
//
// Paso 1: Pobla villanet_hero_images con las primeras 3 URLs válidas de images_json
//         para propiedades con villanet_enabled = true y villanet_hero_images vacío.
//
// Paso 2: Pobla hero_image_url con la primera URL de villanet_hero_images
//         para propiedades con villanet_hero_images poblado pero hero_image_url vacío.
//
// Es IDEMPOTENTE: cada paso solo toca las filas que le corresponden.
// Se puede correr N veces sin efecto colateral.
//
// Uso:
//   node scripts/backfill-hero-images.js

import { pool } from '../src/db.js';

const BATCH_SIZE      = 100;
const MAX_HERO_IMAGES = 3;

// ── Paso 1: images_json → villanet_hero_images ────────────────────────────────
async function backfillHeroImages() {
  console.log('📋 Paso 1: images_json → villanet_hero_images\n');

  let updated = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT listing_id, images_json
       FROM listings
       WHERE villanet_enabled = true
         AND images_json IS NOT NULL
         AND images_json != '[]'::jsonb
         AND villanet_hero_images = '[]'::jsonb
       ORDER BY listing_id
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (rows.length === 0) break;

    const params = [];
    const values = rows.map((r) => {
      const imgs = Array.isArray(r.images_json) ? r.images_json : [];
      const hero = imgs
        .filter(url => typeof url === 'string' && url.startsWith('http'))
        .slice(0, MAX_HERO_IMAGES);

      params.push(r.listing_id, JSON.stringify(hero));
      const lidIdx = params.length - 1;
      const imgIdx = params.length;
      return `($${lidIdx}, $${imgIdx}::jsonb)`;
    });

    await pool.query(
      `UPDATE listings AS l
       SET villanet_hero_images = v.imgs
       FROM (VALUES ${values.join(',')}) AS v(lid, imgs)
       WHERE l.listing_id = v.lid`,
      params
    );

    updated += rows.length;
    console.log(`  ✔ ${updated} propiedades actualizadas...`);
  }

  if (updated === 0) {
    console.log('  — Nada que hacer (todas las propiedades ya tienen villanet_hero_images).\n');
  } else {
    console.log(`\n  ✅ ${updated} propiedades actualizadas.\n`);
  }

  // Verificación
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*)::int AS pendientes
     FROM listings
     WHERE villanet_enabled = true
       AND images_json IS NOT NULL
       AND images_json != '[]'::jsonb
       AND villanet_hero_images = '[]'::jsonb`
  );
  if (pending[0].pendientes === 0) {
    console.log('  🎉 Verificación OK: no quedan villanet_hero_images vacíos.\n');
  } else {
    console.error(`  ⚠️  Quedan ${pending[0].pendientes} propiedades sin migrar.\n`);
  }
}

// ── Paso 2: villanet_hero_images[0].url → hero_image_url ─────────────────────
async function backfillHeroImageUrl() {
  console.log('📋 Paso 2: villanet_hero_images → hero_image_url\n');

  let updated = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT listing_id, villanet_hero_images
       FROM listings
       WHERE villanet_enabled = true
         AND villanet_hero_images IS NOT NULL
         AND villanet_hero_images != '[]'::jsonb
         AND (hero_image_url IS NULL OR hero_image_url = '')
       ORDER BY listing_id
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (rows.length === 0) break;

    const params = [];
    const values = rows
      .map((r) => {
        const imgs = Array.isArray(r.villanet_hero_images) ? r.villanet_hero_images : [];
        // villanet_hero_images es array de objetos { url, order, source }
        const firstUrl = imgs[0]?.url ?? (typeof imgs[0] === 'string' ? imgs[0] : null);
        if (!firstUrl) return null;

        params.push(r.listing_id, firstUrl);
        const lidIdx = params.length - 1;
        const urlIdx = params.length;
        return `($${lidIdx}, $${urlIdx})`;
      })
      .filter(Boolean);

    if (values.length === 0) break;

    await pool.query(
      `UPDATE listings AS l
       SET hero_image_url = v.url
       FROM (VALUES ${values.join(',')}) AS v(lid, url)
       WHERE l.listing_id = v.lid`,
      params
    );

    updated += rows.length;
    console.log(`  ✔ ${updated} propiedades actualizadas...`);
  }

  if (updated === 0) {
    console.log('  — Nada que hacer (todas las propiedades ya tienen hero_image_url).\n');
  } else {
    console.log(`\n  ✅ ${updated} propiedades actualizadas.\n`);
  }

  // Verificación
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*)::int AS pendientes
     FROM listings
     WHERE villanet_enabled = true
       AND villanet_hero_images IS NOT NULL
       AND villanet_hero_images != '[]'::jsonb
       AND (hero_image_url IS NULL OR hero_image_url = '')`
  );
  if (pending[0].pendientes === 0) {
    console.log('  🎉 Verificación OK: no quedan hero_image_url vacíos.\n');
  } else {
    console.error(`  ⚠️  Quedan ${pending[0].pendientes} propiedades sin hero_image_url.\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function backfill() {
  console.log('🚀 Iniciando backfill de imágenes...\n');

  await backfillHeroImages();
  await backfillHeroImageUrl();

  console.log('✅ Backfill completo.');
  await pool.end();
}

backfill().catch(err => {
  console.error('❌ Error en backfill:', err);
  process.exit(1);
});