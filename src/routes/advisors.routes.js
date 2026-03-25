import express from 'express';
import { advisorsController } from '../controllers/advisors.controller.js';
import { uploadLogo } from '../middleware/uploadMiddleware.js';

const router = express.Router();

// Ruta pública para registro de advisors
// uploadLogo parsea el multipart/form-data y deja el archivo en req.file
router.post('/signup', uploadLogo, advisorsController.signup);

// Ruta protegida para obtener perfil (con middleware de autenticación proximamente)
// router.get('/profile', authenticateToken, advisorsController.getProfile);

export default router;