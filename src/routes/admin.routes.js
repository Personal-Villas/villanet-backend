import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { AdminController } from '../controllers/admin.controller.js';

const r = Router();

r.use(auth(true), requireRole('admin'));
r.get('/users', AdminController.listUsers);
r.post('/users/:userId/role', AdminController.setRole);
r.post('/users/:userId/approve', AdminController.approve);
r.post('/users/:userId/reject', AdminController.reject);

export default r;