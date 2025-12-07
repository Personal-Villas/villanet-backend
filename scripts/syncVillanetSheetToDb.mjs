import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: {
    rejectUnauthorized: false
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔧 Helpers para parseo y limpieza
const toIntOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'not populated') return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

const toFloatOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'not populated') return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
};

const toYesNoBoolean = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1') return 'yes';
  if (s === 'no' || s === 'false' || s === '0') return 'no';
  return null;
};

async function main() {
  try {
    const csvPath = process.argv[2];

    if (!csvPath) {
      console.error('❌ Uso: node scripts/syncVillanetSheetToDb.mjs ./data/villanet-v1.csv');
      process.exit(1);
    }

    const resolvedPath = path.isAbsolute(csvPath)
      ? csvPath
      : path.join(__dirname, '..', csvPath);

    console.log('📄 Leyendo CSV desde:', resolvedPath);

    const fileContent = fs.readFileSync(resolvedPath, 'utf8');

    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    console.log(`✅ CSV leído: ${records.length} filas`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Limpiar tabla staging
      console.log('🧹 TRUNCATE villanet_sheet_import');
      await client.query('TRUNCATE TABLE public.villanet_sheet_import');

      // 2) Insertar TODAS las columnas del CSV
      console.log('⬆️ Insertando filas en villanet_sheet_import...');

      const insertText = `
        INSERT INTO public.villanet_sheet_import (
          unit_name,
          "CITY",
          "PMC-INFORMATION",
          "PROPERTY-EMAIL",
          "VILLA NET DESTINATION TAG",
          "VILLA NET PROPERTY MANAGER NAME",
          "VILLA NET PARTNER RESERVATION EMAIL",
          "VILLA NET RANK",
          "VILLA NET COMMISSION RATE",
          "VILLA NET EXCLUSIVE UNITS MANAGED",
          "VILLA NET YEARS IN BUSINESS",
          "VILLA NET AVG RESPONSE TIME HOURS",
          "VILLA NET CALENDAR SYNC 99",
          "VILLA NET CREDIT CARD ACCEPTED",
          "VILLA NET INSURED",
          "VILLA NET BANK TRANSFER ACCEPTED",
          "VILLA NET STANDARDIZED HOUSEKEEPING",
          "VILLA NET STAFF GRATUITY GUIDELINE",
          "VILLA NET GATED COMMUNITY",
          "VILLA NET GOLF VILL",
          "VILLA NET RESORT VILLA",
          "VILLA NET RESORT COLLECTION NAME",
          "VILLA NET CHEF INCLUDED",
          "VILLA NET TRUE BEACH FRONT",
          "VILLA NET COOK INCLUDED",
          "VILLA NET WAITER BUTLER INCLUDED",
          "VILLA NET OCEAN FRONT",
          "VILLA NET OCEAN VIEW",
          "VILLA NET WALK TO BEACH",
          "VILLA NET ACCESSIBLE",
          "VILLA NET PRIVATE GYM",
          "VILLA NET PRIVATE CINEMA",
          "VILLA NET PICKLEBALL",
          "VILLA NET TENNIS",
          "VILLA NET GOLF CART INCLUDED",
          "VILLA NET HEATED POOL"
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
        )
      `;

      for (const row of records) {
        await client.query(insertText, [
          // Textos básicos
          row['Unit Name'] ?? row['unit_name'] ?? null,
          row['CITY'] ?? null,
          row['PMC-INFORMATION'] ?? null,
          row['PROPERTY-EMAIL'] ?? null,
          row['VILLA NET DESTINATION TAG'] ?? null,
          row['VILLA NET PROPERTY MANAGER NAME'] ?? null,
          row['VILLA NET PARTNER RESERVATION EMAIL'] ?? null,
          
          // Numéricos
          toFloatOrNull(row['VILLA NET RANK']),
          toFloatOrNull(row['VILLA NET COMMISSION RATE']),
          toIntOrNull(row['VILLA NET EXCLUSIVE UNITS MANAGED']),
          toIntOrNull(row['VILLA NET YEARS IN BUSINESS']),
          toIntOrNull(row['VILLA NET AVG RESPONSE TIME HOURS']),
          
          // Textos/flags
          row['VILLA NET CALENDAR SYNC 99'] ?? null,
          row['VILLA NET CREDIT CARD ACCEPTED'] ?? null,
          row['VILLA NET INSURED'] ?? null,
          row['VILLA NET BANK TRANSFER ACCEPTED'] ?? null,
          row['VILLA NET STANDARDIZED HOUSEKEEPING'] ?? null,
          row['VILLA NET STAFF GRATUITY GUIDELINE'] ?? null,
          
          // Nuevas columnas booleanas (texto yes/no)
          toYesNoBoolean(row['VILLA NET GATED COMMUNITY']),
          toYesNoBoolean(row['VILLA NET GOLF VILL']),
          toYesNoBoolean(row['VILLA NET RESORT VILLA']),
          row['VILLA NET RESORT COLLECTION NAME'] ?? null,
          toYesNoBoolean(row['VILLA NET CHEF INCLUDED']),
          toYesNoBoolean(row['VILLA NET TRUE BEACH FRONT']),
          toYesNoBoolean(row['VILLA NET COOK INCLUDED']),
          toYesNoBoolean(row['VILLA NET WAITER BUTLER INCLUDED']),
          toYesNoBoolean(row['VILLA NET OCEAN FRONT']),
          toYesNoBoolean(row['VILLA NET OCEAN VIEW']),
          toYesNoBoolean(row['VILLA NET WALK TO BEACH']),
          toYesNoBoolean(row['VILLA NET ACCESSIBLE']),
          toYesNoBoolean(row['VILLA NET PRIVATE GYM']),
          toYesNoBoolean(row['VILLA NET PRIVATE CINEMA']),
          toYesNoBoolean(row['VILLA NET PICKLEBALL']),
          toYesNoBoolean(row['VILLA NET TENNIS']),
          toYesNoBoolean(row['VILLA NET GOLF CART INCLUDED']),
          toYesNoBoolean(row['VILLA NET HEATED POOL']),
        ]);
      }

      console.log('✅ Insert completado en villanet_sheet_import');

      // 3) Ejecutar función de sincronización
      console.log('🔄 Ejecutando SELECT public.sync_villanet_from_sheet()');
      await client.query('SELECT public.sync_villanet_from_sheet()');

      await client.query('COMMIT');
      console.log('🎉 Sync completado con éxito');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error durante sync, rollback realizado');
      console.error(err);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Error inesperado');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();