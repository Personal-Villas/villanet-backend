import express from 'express';
import { advisorsController } from '../controllers/advisors.controller.js';

const router = express.Router();

// Ruta pública para registro de advisors
router.post('/signup', advisorsController.signup);

// Ruta protegida para obtener perfil (con middleware de autenticación proximamente)
// router.get('/profile', authenticateToken, advisorsController.getProfile);

export default router;