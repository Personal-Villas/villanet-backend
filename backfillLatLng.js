import 'dotenv/config';
import { pool } from './src/db.js';
import { fetchListingById, extractLatLng } from './src/services/guesty.service.js';

const GUESTY_TOKEN = process.env.GUESTY_TOKEN;
const BATCH = 25;

async function run() {
  if (!GUESTY_TOKEN) throw new Error('Missing GUESTY_TOKEN in env');

  const { rows } = await pool.query(`
    SELECT listing_id
    FROM public.listings
    WHERE villanet_enabled = true
      AND (lat IS NULL OR lng IS NULL)
    LIMIT 2000;
  `);

  console.log(`Found ${rows.length} listings missing coords`);

  let updated = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);

    for (const r of slice) {
      const id = r.listing_id;

      try {
        const detail = await fetchListingById(GUESTY_TOKEN, id);
        const { lat, lng } = extractLatLng(detail);

        if (lat == null || lng == null) {
          console.log(`[${id}] no coords in guesty`);
          continue;
        }

        await pool.query(
          `UPDATE public.listings SET lat = $1, lng = $2 WHERE listing_id = $3`,
          [lat, lng, id]
        );

        updated++;
        console.log(`[${id}] updated lat/lng: ${lat}, ${lng}`);
      } catch (e) {
        console.warn(`[${id}] failed: ${e?.message || e}`);
      }
    }
  }

  console.log(`Done. Updated ${updated} listings.`);
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
