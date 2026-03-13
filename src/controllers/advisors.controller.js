import { Advisor } from '../models/Advisor.js';
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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
          travel_regions:              travel_regions || [],
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
          `INSERT INTO users (email, full_name, role, status, password_hash, trial_expires_at)
           VALUES ($1, $2, 'ta', 'approved', $3, NULL)
           ON CONFLICT (email) DO UPDATE
             SET full_name     = EXCLUDED.full_name,
                 role          = 'ta',
                 status        = 'approved',
                 password_hash = EXCLUDED.password_hash
           RETURNING id, email, role, status, full_name, trial_expires_at`,
          [normalizedEmail, full_name, password_hash]
        );
        user = userRows[0];

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