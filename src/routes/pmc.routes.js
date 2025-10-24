import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const r = Router();

let seq = 2;
let INQUIRIES = [
  {
    id: 1,
    createdAt: new Date().toISOString(),
    status: 'new',
    propertyId: 'demo-1',
    propertyName: 'Villa Demo',
    dates: { checkIn: '2026-01-10', checkOut: '2026-01-20' },
    guest: { name: 'John Doe', pax: 4 },
    travelAgent: { name: 'TA Example', email: 'ta@example.com', phone: '+1-555-123' },
    notes: 'Needs pool fence'
  }
];

r.get('/inquiries', auth(true), requireRole('pmc','admin'), (req, res) => {
  const { status } = req.query;
  let items = [...INQUIRIES].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  if (status === 'new') items = items.filter(i=>i.status==='new');
  if (status === 'responded') items = items.filter(i=>i.status==='responded');
  res.json({ results: items, total: items.length });
});

r.patch('/inquiries/:id/respond', auth(true), requireRole('pmc','admin'), (req, res) => {
  const id = Number(req.params.id);
  const idx = INQUIRIES.findIndex(i=>i.id===id);
  if (idx === -1) return res.status(404).json({ message: 'Not found' });
  INQUIRIES[idx].status = 'responded';
  INQUIRIES[idx].respondedAt = new Date().toISOString();
  res.json({ ok: true, item: INQUIRIES[idx] });
});

export default r;
