import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { Roles, Status } from '../types.js';

const ACCESS_TTL_MIN = Number(process.env.ACCESS_TTL_MIN || 15);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 7);

// Configurar transporter de email
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 🆕 Función para hashear códigos
function hashCode(code) {
  const secret = process.env.CODE_HASH_SECRET || 'fallback-secret-for-development';
  const hash = crypto
    .createHmac('sha256', secret)
    .update(code)
    .digest('hex');
  
  console.log(`🔐 Hash generated for code: ${code} -> ${hash}`);
  return hash;
}

// 🆕 Función para verificar código hasheado
function verifyHashedCode(plainCode, hashedCode) {
  try {
    const calculatedHash = hashCode(plainCode);
    
    console.log(`🔍 Code verification debug:`, {
      providedCode: plainCode,
      calculatedHash,
      storedHash: hashedCode,
      match: calculatedHash === hashedCode
    });
    
    return calculatedHash === hashedCode;
  } catch (error) {
    console.error('❌ Error in verifyCode:', error);
    return false;
  }
}

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

// Generar código de 6 dígitos
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Enviar email con código
async function sendVerificationEmail(email, code) {
  const mailOptions = {
    from: process.env.SMTP_FROM || '"Villanet" <noreply@villanet.com>',
    to: email,
    subject: 'Your Villanet verification code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #000;">Welcome to Villanet</h2>
        <p style="font-size: 16px; color: #333;">Your verification code is:</p>
        <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <h1 style="font-size: 32px; letter-spacing: 8px; margin: 0; color: #000;">${code}</h1>
        </div>
        <p style="font-size: 14px; color: #666;">This code will expire in 10 minutes.</p>
        <p style="font-size: 14px; color: #666;">If you didn't request this code, please ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
}

// 🧹 Función de limpieza de códigos expirados
async function cleanupExpiredCodes() {
  try {
    const result = await pool.query(
      `DELETE FROM verification_codes WHERE expires_at < CURRENT_TIMESTAMP - interval '1 hour'`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} expired verification codes`);
    }
  } catch (error) {
    console.error('Error cleaning up expired codes:', error);
  }
}

// Ejecutar cleanup cada hora
setInterval(cleanupExpiredCodes, 60 * 60 * 1000);

export const AuthController = {
  // Paso 1: Enviar código de verificación
  async sendCode(req, res) {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email required' });

    const normalizedEmail = String(email).toLowerCase().trim();
    const code = generateCode();
    const codeHash = hashCode(code);

    console.log(`🔐 Generating code for: ${normalizedEmail}`);
    console.log(`📨 Actual code (for debugging): ${code}`);
    console.log(`🔑 Code hash: ${codeHash}`);

    try {
      // Verificar si el usuario existe
      const { rows: existingUser } = await pool.query(
        `SELECT id FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const exists = existingUser.length > 0;
      console.log('🧪 sendCode existingUser count:', existingUser.length, 'for', normalizedEmail);

      // Manejar tiempo en Postgres para evitar problemas de zona horaria
      const result = await pool.query(
        `INSERT INTO verification_codes (email, code_hash, expires_at, user_exists, attempts, created_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + interval '10 minutes', $3, 0, CURRENT_TIMESTAMP)
         ON CONFLICT (email) 
         DO UPDATE SET 
           code_hash   = $2, 
           expires_at  = CURRENT_TIMESTAMP + interval '10 minutes', 
           created_at  = CURRENT_TIMESTAMP, 
           used        = false, 
           attempts    = 0,
           user_exists = $3            // 🆕 MUY IMPORTANTE: actualizar user_exists
         RETURNING id`,
        [normalizedEmail, codeHash, exists]
      );

      console.log(`💾 Code hash saved to database: ${result.rows[0].id}`);
      console.log('📤 sendCode response:', { email: normalizedEmail, userExists: exists });

      await sendVerificationEmail(normalizedEmail, code);

      console.log(`✅ Code sent successfully to ${normalizedEmail}`);

      res.json({ 
        message: 'Verification code sent',
        userExists: exists
      });
    } catch (err) {
      console.error('❌ Error sending code:', err);
      res.status(500).json({ message: 'Failed to send verification code' });
    }
  },

  // Paso 2: Verificar código y hacer login o registro
  async verifyCode(req, res) {
    const { email, code, full_name } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ message: 'Email and code required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    
    console.log(`🔍 Verifying code for: ${normalizedEmail}`);
    console.log(`📨 Code received from frontend: ${code}`);

    try {
      // Usar CURRENT_TIMESTAMP y obtener el código más reciente
      const { rows: codeRows } = await pool.query(
        `SELECT *, 
                expires_at > CURRENT_TIMESTAMP as is_active,
                CURRENT_TIMESTAMP as current_db_time
         FROM verification_codes 
         WHERE email = $1 AND used = false
         ORDER BY created_at DESC 
         LIMIT 1`,
        [normalizedEmail]
      );

      console.log(`📊 Found ${codeRows.length} codes for email`);

      if (!codeRows.length) {
        console.log('❌ No code found for email');
        return res.status(401).json({ message: 'Invalid or expired code' });
      }

      const verificationData = codeRows[0];
      
      // Debug de tiempos
      console.log(`⏰ Time debug:`, {
        currentTime: new Date(),
        dbCurrentTime: verificationData.current_db_time,
        expiresAt: verificationData.expires_at,
        isActive: verificationData.is_active,
        timeDifference: new Date(verificationData.expires_at) - new Date(verificationData.current_db_time)
      });

      if (!verificationData.is_active) {
        console.log('❌ Code expired');
        return res.status(401).json({ message: 'Invalid or expired code' });
      }

      console.log(`📝 Verification data:`, {
        id: verificationData.id,
        attempts: verificationData.attempts,
        expiresAt: verificationData.expires_at,
        userExists: verificationData.user_exists,
        codeHash: verificationData.code_hash ? '***' : 'MISSING'
      });

      if (!verificationData.code_hash) {
        console.error('❌ CRITICAL: code_hash is null or empty in database');
        return res.status(500).json({ message: 'System error. Please request a new code.' });
      }

      if (verificationData.attempts >= 5) {
        console.log('🚫 Too many attempts - blocked');
        return res.status(429).json({ message: 'Too many attempts. Please request a new code.' });
      }

      console.log(`🔐 Starting code verification...`);
      const isValidCode = verifyHashedCode(code, verificationData.code_hash);
      
      console.log(`✅ Code validation result: ${isValidCode}`);
      
      if (!isValidCode) {
        await pool.query(
          `UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1`,
          [verificationData.id]
        );

        const remainingAttempts = 5 - (verificationData.attempts + 1);
        console.log(`❌ Invalid code. ${remainingAttempts} attempts remaining`);
        
        return res.status(401).json({ 
          message: `Invalid code. ${remainingAttempts} attempts remaining.` 
        });
      }

      console.log(`✅ Code valid, user exists: ${verificationData.user_exists}`);

      await pool.query(
        `UPDATE verification_codes SET used = true, attempts = 0 WHERE id = $1`,
        [verificationData.id]
      );

      let user;
      
      if (verificationData.user_exists) {
        const { rows: userRows } = await pool.query(
          `SELECT * FROM users WHERE email = $1`,
          [normalizedEmail]
        );
        user = userRows[0];
        console.log(`👤 Existing user found: ${user.id}`);

        if (user.status === Status.PENDING && user.trial_expires_at && new Date(user.trial_expires_at) < new Date()) {
          console.log('⏰ Trial period expired');
          return res.status(403).json({ message: 'Trial expired. Await admin approval.' });
        }
      } else {
        if (!full_name) {
          return res.status(400).json({ message: 'Full name required for new users' });
        }

        console.log(`👤 Creating new user with full_name: ${full_name}`);
        
        const { rows: newUserRows } = await pool.query(
          `INSERT INTO users (email, full_name, role, status, trial_expires_at, password_hash)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + interval '24 hours', $5)
           RETURNING *`,
          [normalizedEmail, full_name, Roles.TA, Status.PENDING, '']
        );
        user = newUserRows[0];
        console.log(`✅ New user created: ${user.id}`);
      }

      const accessToken = signAccess({ sub: user.id, role: user.role, status: user.status });
      const refreshToken = signRefresh(user.id);
      
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP + interval '${REFRESH_TTL_DAYS} days')`,
        [user.id, refreshToken]
      );
      
      setRefreshCookie(res, refreshToken);

      const ip = req.ip;
      const ua = req.headers['user-agent'];
      await pool.query(
        `INSERT INTO login_audit(user_id, email, success, ip, user_agent) 
         VALUES ($1, $2, true, $3, $4)`,
        [user.id, normalizedEmail, ip, ua]
      );

      console.log(`🎉 Login successful for user: ${user.id}`);

      res.json({
        accessToken,
        user: { 
          id: user.id, 
          email: user.email, 
          role: user.role, 
          status: user.status, 
          trial_expires_at: user.trial_expires_at,
          full_name: user.full_name 
        }
      });
    } catch (err) {
      console.error('❌ Error verifying code:', err);
      res.status(500).json({ message: 'Verification failed' });
    }
  },

  // ... resto de los métodos sin cambios
  async register(req, res) {
    const { email, password, full_name, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });

    const hash = await bcrypt.hash(String(password), 10);
    const newRole = (role && ['admin','ta','pmc'].includes(role)) ? role : Roles.TA;

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, status, trial_expires_at)
       VALUES ($1,$2,$3,$4,$5, CURRENT_TIMESTAMP + interval '24 hours')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role, status, trial_expires_at, full_name`,
      [String(email).toLowerCase(), hash, full_name || null, newRole, Status.PENDING]
    );
    
    if (!rows.length) return res.status(409).json({ message: 'Email already exists' });

    const u = rows[0];
    const accessToken = signAccess({ sub: u.id, role: u.role, status: Status.PENDING });
    const refreshToken = signRefresh(u.id);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2, CURRENT_TIMESTAMP + interval '${REFRESH_TTL_DAYS} days')`,
      [u.id, refreshToken]
    );
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ accessToken, user: u });
  },

  async login(req, res) {
    const { email, password } = req.body || {};
    const ip = req.ip;
    const ua = req.headers['user-agent'];

    const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [String(email).toLowerCase()]);
    if (!rows.length) {
      await pool.query(`INSERT INTO login_audit(email, success, ip, user_agent) VALUES ($1,false,$2,$3)`, [email, ip, ua]);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const user = rows[0];
    
    if (!user.password_hash) {
      return res.status(401).json({ message: 'Please use email verification' });
    }
    
    const ok = await bcrypt.compare(String(password), user.password_hash);

    await pool.query(`INSERT INTO login_audit(user_id,email,success,ip,user_agent) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, email, ok, ip, ua]);

    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    if (user.status === Status.PENDING && user.trial_expires_at && new Date(user.trial_expires_at) < new Date()) {
      return res.status(403).json({ message: 'Trial expired. Await admin approval.' });
    }

    const accessToken = signAccess({ sub: user.id, role: user.role, status: user.status });
    const refreshToken = signRefresh(user.id);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2, CURRENT_TIMESTAMP + interval '${REFRESH_TTL_DAYS} days')`,
      [user.id, refreshToken]
    );
    setRefreshCookie(res, refreshToken);

    res.json({
      accessToken,
      user: { id: user.id, email: user.email, role: user.role, status: user.status, trial_expires_at: user.trial_expires_at, full_name: user.full_name }
    });
  },

  async refresh(req, res) {
    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ message: 'No refresh' });

    const { rows } = await pool.query(`
      SELECT r.*, u.role, u.status FROM refresh_tokens r
      JOIN users u ON u.id=r.user_id
      WHERE r.token=$1 AND r.revoked=false AND r.expires_at>CURRENT_TIMESTAMP`, [token]);

    if (!rows.length) return res.status(401).json({ message: 'Refresh invalid' });

    try {
      jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      const accessToken = signAccess({ sub: rows[0].user_id, role: rows[0].role, status: rows[0].status });
      return res.json({ accessToken });
    } catch {
      return res.status(401).json({ message: 'Refresh invalid' });
    }
  },

  async logout(req, res) {
    const token = req.cookies?.refresh_token;
    if (token) await pool.query(`UPDATE refresh_tokens SET revoked=true WHERE token=$1`, [token]);
    res.clearCookie('refresh_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/auth/refresh'
    });
    res.json({ ok: true });
  },

  async me(req, res) {
    const u = req.user;
    const { rows } = await pool.query(
      `SELECT id,email,role,status,trial_expires_at,full_name,avatar_url FROM users WHERE id=$1`, [u.sub]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  }
};