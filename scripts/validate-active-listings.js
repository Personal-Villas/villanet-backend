// validate-active-listings.js
// Uso: node scripts/validate-active-listings.js
// Script one-time. No modifica datos. Solo lectura.
// Detecta propiedades activas (villanet_enabled = true AND is_listed = true)
// con campos requeridos vacíos o nulos.

import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, "docs");

// ─── Conexión ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isEmpty(val) {
  return val === null || val === undefined || String(val).trim() === "";
}

function validateRow(row) {
  const issues = [];

  // bedrooms → integer ≥ 1
  if (row.bedrooms === null || row.bedrooms === undefined || Number(row.bedrooms) < 1)
    issues.push(`bedrooms: ${row.bedrooms === null ? "NULL" : row.bedrooms}`);

  // bathrooms → numeric ≥ 1
  if (row.bathrooms === null || row.bathrooms === undefined || Number(row.bathrooms) < 1)
    issues.push(`bathrooms: ${row.bathrooms === null ? "NULL" : row.bathrooms}`);

  // hero_image_url → texto no vacío
  if (isEmpty(row.hero_image_url))
    issues.push("hero_image_url: vacío/NULL");

  // images_json → array con al menos 1 elemento
  if (!row.images_json || !Array.isArray(row.images_json) || row.images_json.length < 1)
    issues.push(`images_json: ${!row.images_json ? "NULL" : "[]"}`);

  // name → texto no vacío
  if (isEmpty(row.name))
    issues.push("name: vacío/NULL");

  // description → texto no vacío y mínimo 50 caracteres
  if (isEmpty(row.description))
    issues.push("description: vacío/NULL");
  else if (String(row.description).trim().length < 50)
    issues.push(`description: muy corta (${String(row.description).trim().length} chars, mínimo 50)`);

  // max_guests → integer ≥ 1
  if (row.max_guests === null || row.max_guests === undefined || Number(row.max_guests) < 1)
    issues.push(`max_guests: ${row.max_guests === null ? "NULL" : row.max_guests}`);

  // location_text OR (city AND country) → al menos uno no vacío
  const hasLocation =
    !isEmpty(row.location_text) ||
    (!isEmpty(row.city) && !isEmpty(row.country));
  if (!hasLocation)
    issues.push("location: location_text y city/country todos vacíos/NULL");

  // ── Opcionales ──────────────────────────────────────────────────────────────

  // amenities_json → no nulo (puede estar vacío)
  if (row.amenities_json === null || row.amenities_json === undefined)
    issues.push("amenities_json: NULL (opcional)");

  // lat / lng → ambos no nulos
  if (row.lat === null || row.lat === undefined)
    issues.push("lat: NULL (opcional)");
  if (row.lng === null || row.lng === undefined)
    issues.push("lng: NULL (opcional)");

  return issues;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== VillaNet — Validación de propiedades activas ===\n");

  let client;
  try {
    client = await pool.connect();

    const { rows } = await client.query(`
      SELECT
        listing_id,
        name,
        bedrooms,
        bathrooms,
        hero_image_url,
        images_json,
        description,
        max_guests,
        location_text,
        city,
        country,
        amenities_json,
        lat,
        lng
      FROM listings
      WHERE villanet_enabled = true
        AND is_listed = true
      ORDER BY name ASC
    `);

    console.log(`Propiedades activas encontradas: ${rows.length}\n`);

    const failed = [];

    for (const row of rows) {
      const issues = validateRow(row);
      if (issues.length > 0) {
        failed.push({
          listing_id: row.listing_id,
          name: row.name || "(sin nombre)",
          url: `/properties/${row.listing_id}`,
          issues,
        });
      }
    }

    // ── Resultado en consola ───────────────────────────────────────────────

    if (failed.length === 0) {
      console.log("Todas las propiedades activas tienen los campos requeridos OK ✅");
    } else {
      console.log(`❌ ${failed.length} propiedad(es) con datos incompletos:\n`);
      for (const p of failed) {
        console.log(`  📌 ${p.name}`);
        console.log(`     listing_id : ${p.listing_id}`);
        console.log(`     URL        : ${p.url}`);
        console.log(`     Problemas  :`);
        for (const issue of p.issues) {
          console.log(`       - ${issue}`);
        }
        console.log();
      }
    }

    // ── Output a archivos ──────────────────────────────────────────────────

    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // JSON
    const jsonPath = path.join(DOCS_DIR, `validate-active-listings-${timestamp}.json`);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalActive: rows.length,
          totalWithIssues: failed.length,
          properties: failed,
        },
        null,
        2
      )
    );
    console.log(`📄 JSON guardado en: ${jsonPath}`);

    // CSV
    const csvPath = path.join(DOCS_DIR, `validate-active-listings-${timestamp}.csv`);
    const csvLines = [
      ["listing_id", "name", "url", "issues"].join(","),
      ...failed.map((p) =>
        [
          p.listing_id,
          `"${p.name.replace(/"/g, '""')}"`,
          p.url,
          `"${p.issues.join(" | ").replace(/"/g, '""')}"`,
        ].join(",")
      ),
    ];
    fs.writeFileSync(csvPath, csvLines.join("\n"));
    console.log(`📄 CSV guardado en: ${csvPath}`);

  } catch (err) {
    console.error("Error al conectar o ejecutar la query:");
    console.error(err.message);
    process.exit(1);
  } finally {
    client?.release();
    await pool.end();
  }
}

main();