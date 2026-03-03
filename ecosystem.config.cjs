module.exports = {
  apps: [
    // ─── Servidor principal ───────────────────────────────────────────────
    {
      name: "villanet-api",
      script: "./src/server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      interpreter: "node",
      interpreter_args: "--experimental-vm-modules",
      env_production: {
        NODE_ENV: "production",
      },
    },

    // ─── Cron de sincronización de disponibilidad ─────────────────────────
    // Corre a las 0:00, 4:00, 8:00, 12:00, 16:00, 20:00
    // Proceso independiente de villanet-api
    // Autorestart:false evita overlap si la corrida anterior sigue activa
    {
      name: "sync-availability-cron",
      script: "./scripts/syncAvailability.js",
      instances: 1,
      autorestart: false,
      cron_restart: "0 */4 * * *",
      watch: false,
      interpreter: "node",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
