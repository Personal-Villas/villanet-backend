import { Advisor } from '../models/Advisor.js';
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { uploadToS3, deleteFromS3ByUrl } from '../utils/s3Upload.js';

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 7);
const ACCESS_TTL_MIN   = Number(process.env.ACCESS_TTL_MIN  || 15);

// ✅ Usar las mismas funciones de firma que auth_controller para que /auth/me acepte el token
function signAccess(payload, ttlMinutes = ACCESS_TTL_MIN) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: `${ttlMinutes}m`,
  });
}

function signRefresh(userId, ttlDays = REFRESH_TTL_DAYS) {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: `${ttlDays}d`,
  });
}

function setRefreshCookie(res, token, ttlDays = REFRESH_TTL_DAYS) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/auth/refresh',
    maxAge: ttlDays * 24 * 3600 * 1000,
  });
}

// ── Normalizar travel_regions ──────────────────────────────────────
// multipart puede llegar como: string JSON, string simple, array, o undefined
function parseRegions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Caso: '[\"Caribbean\",\"Mexico\"]'  →  JSON.parse
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch { return [raw]; }
  }
  // Caso: un solo valor como string simple 'Caribbean'
  return [raw];
}

export const advisorsController = {
  async signup(req, res) {
    try {
      const {
        first_name,
        last_name,
        email,
        password,
        advisor_type,
        travel_regions,
        typical_group_size,
        villa_budget_range,
        commission_preference,
        website,
        agreed_to_terms,
        profile_completion_percentage
      } = req.body;

      // Validaciones básicas
      if (!first_name || !last_name || !email || !password) {
        return res.status(400).json({
          success: false,
          message: 'First name, last name, email and password are required'
        });
      }

      const normalizedEmail = String(email).toLowerCase().trim();

      // Verificar si el email ya existe en advisors
      const existingAdvisor = await Advisor.findByEmail(normalizedEmail);
      if (existingAdvisor) {
        return res.status(409).json({
          success: false,
          message: 'An advisor with this email already exists'
        });
      }

      // Subir logo a S3 si viene en el request (campo opcional)
      let avatarUrl = null;
      if (req.file) {
        avatarUrl = await uploadToS3(req.file.buffer, req.file.originalname, 'imagenes-logos-villanet');
      }

      const saltRounds = 12;
      const password_hash = await bcrypt.hash(password, saltRounds);
      const full_name = `${first_name} ${last_name}`;

      // ✅ Usar una transacción para crear el advisor y el user de forma atómica.
      // Si cualquiera de los dos falla, se hace rollback de ambos.
      const client = await pool.connect();
      let newAdvisor, user;

      try {
        await client.query('BEGIN');

        // 1. Crear el advisor
        const advisorData = {
          first_name,
          last_name,
          email: normalizedEmail,
          password_hash,
          advisor_type:                advisor_type || null,
          travel_regions:              parseRegions(travel_regions),
          typical_group_size:          typical_group_size || null,
          villa_budget_range:          villa_budget_range || null,
          commission_preference:       commission_preference || null,
          website:                     website || null,
          agreed_to_terms:             agreed_to_terms || false,
          profile_completion_percentage: profile_completion_percentage || 20
        };

        newAdvisor = await Advisor.create(advisorData);

        // 2. ✅ Crear (o vincular) el user en la tabla users para que /auth/me funcione.
        // ON CONFLICT DO UPDATE para el caso en que ya existiera un user huérfano con ese email.
        const { rows: userRows } = await client.query(
          `INSERT INTO users (email, full_name, role, status, password_hash, trial_expires_at, avatar_url)
           VALUES ($1, $2, 'ta', 'approved', $3, NULL, $4)
           ON CONFLICT (email) DO UPDATE
             SET full_name     = EXCLUDED.full_name,
                 role          = 'ta',
                 status        = 'approved',
                 password_hash = EXCLUDED.password_hash,
                 avatar_url    = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
           RETURNING id, email, role, status, full_name, trial_expires_at, avatar_url`,
          [normalizedEmail, full_name, password_hash, avatarUrl]
        );
        user = userRows[0];

        // Si el usuario ya tenía un logo y subió uno nuevo, borrar el viejo de S3
        if (avatarUrl && user.avatar_url && user.avatar_url !== avatarUrl) {
          deleteFromS3ByUrl(user.avatar_url); // fire-and-forget, no bloquea la respuesta
        }

        // 3. ✅ Opcional: guardar la referencia cruzada si la tabla advisors tiene columna user_id
        // await client.query(`UPDATE advisors SET user_id = $1 WHERE id = $2`, [user.id, newAdvisor.id]);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // 4. ✅ Firmar con JWT_ACCESS_SECRET (igual que auth_controller) para que /auth/me lo acepte
      const accessToken  = signAccess({ sub: user.id, role: user.role, status: user.status, email: user.email  });
      const refreshToken = signRefresh(user.id);

      // 5. Persistir refresh token
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + interval '${REFRESH_TTL_DAYS} days')`,
        [user.id, refreshToken]
      );

      // 6. Setear refresh token como cookie httpOnly (igual que el resto del auth)
      setRefreshCookie(res, refreshToken);

      res.status(201).json({
        success: true,
        message: 'Advisor created successfully',
        accessToken,
        user: {
          id:        user.id,
          email:     user.email,
          role:      user.role,
          status:    user.status,
          full_name: user.full_name
        },
        advisorId: newAdvisor.id
      });

    } catch (error) {
      console.error('Advisor signup error:', error);

      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'An advisor with this email already exists'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error during advisor registration'
      });
    }
  },

  // GET /advisors/profile
  // Requiere: auth() middleware
  async getProfile(req, res) {
    console.log('getProfile called, req.user:', req.user); 
    try {
      const email = req.user?.email;
      console.log('Looking up email:', email);
      if (!email) return res.status(401).json({ success: false, message: 'Unauthorized' });
 
      const profile = await Advisor.getProfileByEmail(email);
      if (!profile) {
        return res.status(404).json({ success: false, message: 'Advisor profile not found' });
      }
 
      res.json({ success: true, profile });
    } catch (error) {
      console.error('Get advisor profile error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },

  // PATCH /advisors/profile
  // Requiere: auth() middleware
  // Body: { website }
  async updateProfile(req, res) {
    try {
      const email = req.user?.email;
      if (!email) return res.status(401).json({ success: false, message: 'Unauthorized' });
 
      const { website } = req.body;
 
      const updated = await Advisor.updateProfile(email, { website });
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Advisor not found' });
      }
 
      res.json({ success: true, profile: updated });
    } catch (error) {
      console.error('Update advisor profile error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },
 
  // POST /advisors/profile/logo
  // Requiere: auth() middleware + uploadLogo middleware
  // Field: agency_logo (file)
  async updateLogo(req, res) {
    try {
      const email = req.user?.email;
      const userId = req.user?.sub;
      if (!email || !userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
 
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file provided' });
      }
 
      // 1. Obtener el avatar_url actual para borrar el viejo de S3
      const { rows } = await pool.query(
        'SELECT avatar_url FROM users WHERE id = $1',
        [userId]
      );
      const oldAvatarUrl = rows[0]?.avatar_url;
 
      // 2. Subir el nuevo logo a S3
      const newAvatarUrl = await uploadToS3(
        req.file.buffer,
        req.file.originalname,
        'imagenes-logos-villanet'
      );
 
      // 3. Actualizar avatar_url en users
      await pool.query(
        'UPDATE users SET avatar_url = $1 WHERE id = $2',
        [newAvatarUrl, userId]
      );
 
      // 4. Borrar el viejo de S3 (fire-and-forget)
      if (oldAvatarUrl && oldAvatarUrl !== newAvatarUrl) {
        deleteFromS3ByUrl(oldAvatarUrl);
      }
 
      res.json({ success: true, avatar_url: newAvatarUrl });
    } catch (error) {
      console.error('Update advisor logo error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },
 
  // DELETE /advisors/profile/logo
  // Requiere: auth() middleware
  async removeLogo(req, res) {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
 
      const { rows } = await pool.query(
        'SELECT avatar_url FROM users WHERE id = $1',
        [userId]
      );
      const oldAvatarUrl = rows[0]?.avatar_url;
 
      if (oldAvatarUrl) {
        deleteFromS3ByUrl(oldAvatarUrl); // fire-and-forget
      }
 
      await pool.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [userId]);
 
      res.json({ success: true, avatar_url: null });
    } catch (error) {
      console.error('Remove advisor logo error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },

  // ── CHANGE PASSWORD ────────────────────────────────────────────────────────
  // POST /advisors/profile/change-password
  // Requiere: auth() middleware (usuario ya logueado)
  // Body: { currentPassword, newPassword }
  async changePassword(req, res) {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'currentPassword and newPassword are required' });
      }
      if (String(newPassword).length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      }

      // Obtener el hash actual
      const { rows } = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (!rows.length) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const existingHash = rows[0].password_hash;

      // Si el usuario no tiene contraseña (solo usó código), el campo puede estar vacío
      if (!existingHash) {
        return res.status(400).json({ success: false, message: 'No password set. Please use forgot password to create one.' });
      }

      const isMatch = await bcrypt.compare(String(currentPassword), existingHash);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      const newHash = await bcrypt.hash(String(newPassword), 12);
      await pool.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newHash, userId]
      );

      console.log(`✅ change-password OK for user ${userId}`);
      res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },
};