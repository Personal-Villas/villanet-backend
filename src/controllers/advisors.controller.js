import { Advisor } from '../models/Advisor.js';
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { uploadToS3, deleteFromS3ByUrl } from '../utils/s3Upload.js';

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 7);
const ACCESS_TTL_MIN   = Number(process.env.ACCESS_TTL_MIN  || 15);

// ✅ Usar las mismas funciones de firma que auth_controller para que /auth/me acepte el token
function signAccess(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: `${ACCESS_TTL_MIN}m` });
}

function signRefresh(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_DAYS}d` });
}

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/auth/refresh',
    maxAge: REFRESH_TTL_DAYS * 24 * 3600 * 1000,
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
      const accessToken  = signAccess({ sub: user.id, role: user.role, status: user.status });
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
  }
};