import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import 'dotenv/config';

import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import listingsRoutes from './routes/listings.routes.js';
import pmcRoutes from './routes/pmc.routes.js';
import availabilityRoutes from './routes/availability.routes.js';
import badgesRoutes from './routes/badges.routes.js';
import propertyBadgesRoutes from './routes/property-badges.routes.js';
import adminPropertiesRoutes from './routes/admin.properties.routes.js';

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
    ],
    credentials: true,
  })
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/listings', listingsRoutes);
app.use('/pmc', pmcRoutes);
app.use('/availability', availabilityRoutes);
app.use('/badges', badgesRoutes);
app.use('/properties', propertyBadgesRoutes);
app.use('/admin/properties', adminPropertiesRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`✅ API listening on :${port}`));
