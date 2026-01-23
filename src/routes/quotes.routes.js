import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  createQuote,
  sendQuoteEmail,
  getQuoteDetails,
  quotesAvailabilityCheck
} from '../controllers/quotes.controller.js';

const router = Router();

// Rutas protegidas para agentes de ventas (admin, ta, pmc)
router.post('/', auth(true), requireRole('admin', 'ta', 'pmc'), createQuote);
router.get('/:id', auth(true), requireRole('admin', 'ta', 'pmc'), getQuoteDetails);
router.post('/:id/send', auth(true), requireRole('admin', 'ta', 'pmc'), sendQuoteEmail);
router.post(
    '/availability-check',
    auth(true),
    requireRole('admin', 'ta', 'pmc'),
    quotesAvailabilityCheck
  );

export default router;