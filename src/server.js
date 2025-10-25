import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import 'dotenv/config';

import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import listingsRoutes from './routes/listings.routes.js';
import pmcRoutes from './routes/pmc.routes.js';
import syncRoutes from './routes/sync.routes.js';
import availabilityRoutes from './routes/availability.routes.js';

const app = express();

/* 🔹 Necesario para Render / HTTPS y cookies Secure */
app.set('trust proxy', 1);

/* 🔹 Middlewares base */
app.use(helmet());
app.use(express.json());
app.use(cookieParser());

/* 🔹 Configurar CORS correctamente para front en Render */
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:4000',
      'https://villanet-frontend.onrender.com', // tu dominio front render
    ],
    credentials: true, // permite envío de cookies
  })
);

/* 🔹 Health check */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* 🔹 Rutas */
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/listings', listingsRoutes);
app.use('/pmc', pmcRoutes);
app.use('/sync', syncRoutes);
app.use('/availability', availabilityRoutes);

/* 🔹 Catch-all simple (opcional) */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

/* 🔹 Arranque */
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`✅ API listening on :${port}`));
