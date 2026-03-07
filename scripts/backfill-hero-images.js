// scripts/backfill-hero-images.js
//
// Pobla villanet_hero_images con las primeras 3 URLs válidas de images_json
// para todas las propiedades con villanet_enabled = true.
//
// Es IDEMPOTENTE: solo actualiza filas donde villanet_hero_images está vacío ('[]').
// Se puede correr N veces sin efecto colateral.
//
// Uso:
//   node scripts/backfill-hero-images.js
//
// Verificación post-backfill (debe devolver 0):
//   SELECT COUNT(*) FROM listings
//   WHERE villanet_enabled = true
//     AND images_json IS NOT NULL
//     AND images_json != '[]'::jsonb
//     AND villanet_hero_images = '[]'::jsonb;

import { pool } from '../src/db.js';

const BATCH_SIZE      = 100;
const MAX_HERO_IMAGES = 3;

async function backfill() {
  console.log('🚀 Iniciando backfill de villanet_hero_images...\n');

  let updated = 0;

  while (true) {
    // El WHERE filtra las pendientes; cada iteración trae
    // siempre las primeras BATCH_SIZE filas no migradas. Al actualizarlas,
    // desaparecen del WHERE en la siguiente vuelta.
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

    // Construir valores para el UPDATE en batch
    const params  = [];
    const values  = rows.map((r, i) => {
      const imgs = Array.isArray(r.images_json) ? r.images_json : [];
      const hero = imgs
        .filter(url => typeof url === 'string' && url.startsWith('http'))
        .slice(0, MAX_HERO_IMAGES);

      // $1, $2, ... para evitar inyección con listing_ids que podrían tener caracteres especiales
      params.push(r.listing_id, JSON.stringify(hero));
      const lidIdx  = params.length - 1; // índice del listing_id
      const imgIdx  = params.length;     // índice del array hero
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

  console.log(`\n✅ Backfill completado: ${updated} propiedades actualizadas.`);

  // Verificación automática al final
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*)::int AS pendientes
     FROM listings
     WHERE villanet_enabled = true
       AND images_json IS NOT NULL
       AND images_json != '[]'::jsonb
       AND villanet_hero_images = '[]'::jsonb`
  );

  const pendientes = pending[0].pendientes;
  if (pendientes === 0) {
    console.log('🎉 Verificación OK: no quedan propiedades sin migrar.');
  } else {
    console.error(`⚠️  Atención: quedan ${pendientes} propiedades sin migrar.`);
    process.exit(1);
  }

  await pool.end();
}

backfill().catch(err => {
  console.error('❌ Error en backfill:', err);
  process.exit(1);
});