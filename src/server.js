import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import 'dotenv/config';

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
import quotesRoutes from './routes/quotes.routes.js'
import leadsRoutes from './routes/leads.routes.js';

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
      'http://localhost:5173',
      'https://stbarts-villas.onrender.com'
    ],
    credentials: true,
  })
);

app.get('/health', (_req, res) => res.json({ ok: true }));

// 🆕 Rutas PÚBLICAS primero (sin autenticación)
app.use('/public', publicMessagesRouter);
app.use('/public/listings', publicListingsRoutes);
app.use('/badges', badgesRoutes);
app.use('/advisors', advisorsRoutes);
app.use('/property-managers', propertyManagersRoutes);
app.use('/cart', cartRoutes);
app.use('/early-access', earlyAccessRoutes);
app.use('/api/leads', leadsRoutes);

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

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`✅ API listening on :${port}`));
