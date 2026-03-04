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
  ],
};
