import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { syncGuestyListings } from '../services/syncListings.service.js';

const r = Router();

r.post('/sync-listings', auth(true), requireRole('admin'), async (req, res) => {
  try {
    const count = await syncGuestyListings();
    res.json({ ok: true, count });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ message: err.message });
  }
});

export default r;