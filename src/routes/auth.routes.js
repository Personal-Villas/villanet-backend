import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';

const r = Router();

r.post('/register', AuthController.register);
r.post('/login',    AuthController.login);
r.post('/refresh',  AuthController.refresh);
r.post('/logout',   auth(false), AuthController.logout);
r.get('/me',        auth(true),  AuthController.me);

export default r;
