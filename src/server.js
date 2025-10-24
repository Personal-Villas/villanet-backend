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

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: ['http://localhost:3000'], // Vite
  credentials: true
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/listings', listingsRoutes);
app.use('/pmc', pmcRoutes);
app.use('/sync', syncRoutes);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API listening on :${port}`));
