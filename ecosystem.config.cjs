module.exports = {
  apps: [
    // ─── Servidor principal ───────────────────────────────────────────────────
    {
      name: "villanet-api",
      script: "./src/server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron incremental: cada 4 horas (0, 4, 8, 12, 16, 20) ────────────────
    // Si el full sync de las 3 AM corrió recientemente, el lock lo detecta
    // y puede saltearse sin conflicto (CA3 de la tarea anterior).
    {
      name: "sync-availability-cron",
      script: "./scripts/syncAvailability.js",
      args: "",                          // sin --full → modo incremental
      instances: 1,
      autorestart: false,                // no reiniciar en overlap
      cron_restart: "0 */4 * * *",
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron full sync: diario a las 3:00 AM ────────────────────────────────
    // Fuerza resync completo sin condiciones (CA2).
    // Proceso independiente: si el incremental cae, este actúa de salvavidas.
    {
      name: "sync-availability-full",
      script: "./scripts/syncAvailability.js",
      args: "--full",                    // fuerza resync total
      instances: 1,
      autorestart: false,
      cron_restart: "0 3 * * *",         // CA1: 3:00 AM todos los días
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron incremental fees: cada 6 horas ─────────────────────────────────
    // Solo re-sincroniza propiedades con fees vencidos (> 24hs) o con error.
    {
      name: "sync-fees-cron",
      script: "./scripts/syncFees.js",
      args: "",                          // sin --full → modo incremental
      instances: 1,
      autorestart: false,
      cron_restart: "0 */6 * * *",       // cada 6 horas
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron full sync fees: diario a las 4:00 AM ───────────────────────────
    // Corre 1 hora después del full sync de availability (3 AM).
    // Fuerza resync completo de fees de todas las propiedades habilitadas.
    {
      name: "sync-fees-full",
      script: "./scripts/syncFees.js",
      args: "--full",
      instances: 1,
      autorestart: false,
      cron_restart: "0 4 * * *",         // 4:00 AM todos los días
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron Guardian: lunes y miércoles a las 8:00 AM ──────────────────────
    // Audita y limpia datos según reglas del guardian service.
    // Corre después del peak de sync (3-4 AM) para operar sobre datos frescos.
    {
      name: "guardian-cron",
      script: "./scripts/guardian.cron.js",
      args: "",
      instances: 1,
      autorestart: false,                // no reiniciar si el proceso cae
      cron_restart: "0 8 * * 1,3",       // lunes y miércoles a las 8:00 AM
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
