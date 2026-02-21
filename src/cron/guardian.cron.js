/**
 * guardian.cron.js
 *
 * Registra el CronJob del Guardian usando node-cron.
 * Importar este archivo en tu server.js / app.js para activarlo.
 *
 * Ejemplo en server.js:
 *   import './cron/guardian.cron.js';
 */

import cron from "node-cron";
import { runGuardian } from "../services/guardian.service.js";

// ─── Configuración del schedule ───────────────────────────────────────────────
//
//  Formato cron: ┌─ minuto (0-59)
//                │  ┌─ hora (0-23)
//                │  │  ┌─ día del mes (1-31)
//                │  │  │  ┌─ mes (1-12)
//                │  │  │  │  ┌─ día de semana (0-7, 0 y 7 = domingo)
//                │  │  │  │  │
//               "m  h  d  M  D"
//
//  Cada 48 horas (lunes y miércoles a las 8:00 AM UTC):
//    "0 8 * * 1,3"
//
//  Una vez por semana (lunes a las 8:00 AM UTC):
//    "0 8 * * 1"
//
//  Para testing — cada minuto (solo en dev):
//    "* * * * *"

const SCHEDULE = process.env.GUARDIAN_CRON_SCHEDULE || "0 8 * * 1,3";
const TIMEZONE = "America/New_York";

// ─── Registro ─────────────────────────────────────────────────────────────────

if (!cron.validate(SCHEDULE)) {
  console.error(`❌ Guardian: invalid cron schedule "${SCHEDULE}". Job not registered.`);
} else {
  cron.schedule(
    SCHEDULE,
    async () => {
      console.log(`\n⏰ Guardian cron triggered [${new Date().toISOString()}]`);
      try {
        const summary = await runGuardian();
        console.log("🛡️  Guardian cron completed:", JSON.stringify(summary, null, 2));
      } catch (err) {
        // El guardian ya loguea internamente — esto atrapa errores inesperados
        console.error("🔥 Guardian cron unhandled error:", err.message);
      }
    },
    {
      scheduled: true,
      timezone: TIMEZONE,
    }
  );

  console.log(`🛡️  Guardian cron registered — schedule: "${SCHEDULE}" (${TIMEZONE})`);
}

// ─── Ejecución manual (para testing desde CLI) ────────────────────────────────
//
//  node src/cron/guardian.cron.js --run-now
//
if (process.argv.includes("--run-now")) {
  console.log("🛡️  Guardian: manual run triggered via --run-now flag");
  runGuardian()
    .then((summary) => {
      console.log("\n✅ Manual run completed:", JSON.stringify(summary, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Manual run failed:", err.message);
      process.exit(1);
    });
}