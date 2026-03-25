import express from 'express';
import { advisorsController } from '../controllers/advisors.controller.js';
import { uploadLogo } from '../middleware/uploadMiddleware.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// ── Pública ────────────────────────────────────────────────────────────────
// uploadLogo parsea el multipart/form-data y deja el archivo en req.file
router.post('/signup', uploadLogo, advisorsController.signup);

// ── Protegidas (requieren JWT válido) ──────────────────────────────────────
router.get   ('/profile',      auth(),             advisorsController.getProfile);
router.patch ('/profile',      auth(),             advisorsController.updateProfile);
router.post  ('/profile/logo', auth(), uploadLogo, advisorsController.updateLogo);
router.delete('/profile/logo', auth(),             advisorsController.removeLogo);

export default router;