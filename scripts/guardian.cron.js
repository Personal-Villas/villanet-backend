/**
 * guardian.cron.js
 *
 * Script standalone del Guardian — ejecutado por pm2 vía cron_restart.
 * NO registra su propio cron interno; pm2 maneja el schedule.
 *
 * Uso manual:
 *   node scripts/guardian.cron.js
 */

import { runGuardian } from "../src/services/guardian.service.js";

const startTime = new Date();
console.log(`[${startTime.toISOString()}] 🛡️  Iniciando Guardian...`);

runGuardian()
  .then((summary) => {
    const duration_s = parseFloat(((new Date() - startTime) / 1000).toFixed(1));
    console.log(`\n[${new Date().toISOString()}] ✅ Guardian finalizado en ${duration_s}s`);
    console.log("📋 Resumen:", JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n❌ Guardian falló:`, err.message);
    process.exit(1);
  });