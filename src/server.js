import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import 'dotenv/config';
import { pool } from './db.js';
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import listingsRoutes from './routes/listings.routes.js';
import publicListingsRoutes from './routes/public-listings.routes.js'; 
import pmcRoutes from './routes/pmc.routes.js';
import availabilityRoutes from './routes/availability.routes.js';
import badgesRoutes from './routes/badges.routes.js';
import propertyBadgesRoutes from './routes/property-badges.routes.js';
import adminPropertiesRoutes from './routes/admin.properties.routes.js';
import bookingRoutes from './routes/booking.routes.js';
import advisorsRoutes from './routes/advisors.routes.js';
import propertyManagersRoutes from './routes/propertyManagers.routes.js';
import publicMessagesRouter from './routes/public-messages.routes.js';
import cartRoutes from './routes/cart.routes.js';
import earlyAccessRoutes from './routes/early-access.routes.js';
import quotesRoutes from './routes/quotes.routes.js';
import cron from 'node-cron';
import { syncAllListingRates } from './services/ratesSync.service.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:4000',
      'https://villanet-frontend.onrender.com',
      'https://thevillanet.com',
      'https://www.thevillanet.com',
    ],
    credentials: true,
  })
);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Rutas públicas primero
app.use('/public', publicMessagesRouter);
app.use('/public/listings', publicListingsRoutes);
app.use('/badges', badgesRoutes);
app.use('/advisors', advisorsRoutes);
app.use('/property-managers', propertyManagersRoutes);
app.use('/cart', cartRoutes);
app.use('/early-access', earlyAccessRoutes);

// Rutas protegidas
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/listings', listingsRoutes);
app.use('/pmc', pmcRoutes);
app.use('/availability', availabilityRoutes);
app.use('/properties', propertyBadgesRoutes);
app.use('/admin/properties', adminPropertiesRoutes);
app.use('/booking', bookingRoutes);
app.use('/quotes', quotesRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ----------------------
// CRON PARA SYNC DE TARIFAS
// ----------------------

// Bandera global para evitar solapamientos
let isSyncRunning = false;

// Schedule configurable vía .env (dev: cada 10 min, prod: cada 6 horas)
const ratesCronSchedule = process.env.CRON_RATES_SCHEDULE || '0 */6 * * *';

cron.schedule(ratesCronSchedule, async () => {
  if (isSyncRunning) {
    console.log(`[${new Date().toISOString()}] Sync de tarifas YA EN CURSO → saltando esta ejecución`);
    return;
  }

  isSyncRunning = true;
  console.log(`[${new Date().toISOString()}] Iniciando sincronización automática de tarifas... (schedule: ${ratesCronSchedule})`);

  try {
    await syncAllListingRates();
    console.log(`[${new Date().toISOString()}] Sync de tarifas completado exitosamente.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en cron de sync tarifas:`, err.message);
    try {
      await pool.query(
        `INSERT INTO sync_logs (event_type, message, details) VALUES ('rates_sync_error', $1, $2)`,
        [
          'Error en cron automático',
          { 
            error: err.message, 
            stack: err.stack ? err.stack.slice(0, 1000) : null  // Limitamos stack para no llenar DB
          }
        ]
      );
    } catch (dbErr) {
      console.error('No se pudo loguear error en DB:', dbErr.message);
    }
  } finally {
    isSyncRunning = false;  // Siempre liberar la bandera, pase lo que pase
  }
});

// Puerto
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`✅ API listening on :${port}`);
  console.log(`Cron de rates configurado con schedule: ${ratesCronSchedule}`);
});