import express from 'express';
import { propertyManagersController } from '../controllers/property.managers.controller.js';

const router = express.Router();

// Ruta pública para registro de property managers
router.post('/signup', propertyManagersController.signup);

export default router;