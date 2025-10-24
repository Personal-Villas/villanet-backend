import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Roles, Status } from '../types.js';

const ACCESS_TTL_MIN = Number(process.env.ACCESS_TTL_MIN || 15);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 7);

function signAccess(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: `${ACCESS_TTL_MIN}m` });
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_DAYS}d` });
}
function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TTL_DAYS * 24 * 3600 * 1000,
    domain: process.env.COOKIE_DOMAIN
  });
}

export const AuthController = {
  async register(req, res) {
    const { email, password, full_name, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });

    const hash = await bcrypt.hash(String(password), 10);
    const newRole = (role && ['admin','ta','pmc'].includes(role)) ? role : Roles.TA;

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, status, trial_expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '24 hours')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role, status, trial_expires_at`,
      [String(email).toLowerCase(), hash, full_name || null, newRole, Status.PENDING]
    );
    
    if (!rows.length) return res.status(409).json({ message: 'Email already exists' });

    const u = rows[0];
    const accessToken = signAccess({ sub: u.id, role: Roles.AGENT, status: Status.PENDING });
    const refreshToken = signRefresh(u.id);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2, now() + interval '${REFRESH_TTL_DAYS} days')`,
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
    const ok = await bcrypt.compare(String(password), user.password_hash);

    await pool.query(`INSERT INTO login_audit(user_id,email,success,ip,user_agent) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, email, ok, ip, ua]);

    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    // if pending and trial expired -> block
    if (user.status === Status.PENDING && user.trial_expires_at && new Date(user.trial_expires_at) < new Date()) {
      return res.status(403).json({ message: 'Trial expired. Await admin approval.' });
    }

    const accessToken = signAccess({ sub: user.id, role: user.role, status: user.status });
    const refreshToken = signRefresh(user.id);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2, now() + interval '${REFRESH_TTL_DAYS} days')`,
      [user.id, refreshToken]
    );
    setRefreshCookie(res, refreshToken);

    res.json({
      accessToken,
      user: { id: user.id, email: user.email, role: user.role, status: user.status, trial_expires_at: user.trial_expires_at }
    });
  },

  async refresh(req, res) {
    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ message: 'No refresh' });

    const { rows } = await pool.query(`
      SELECT r.*, u.role, u.status FROM refresh_tokens r
      JOIN users u ON u.id=r.user_id
      WHERE r.token=$1 AND r.revoked=false AND r.expires_at>now()`, [token]);

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
    res.clearCookie('refresh_token', { domain: process.env.COOKIE_DOMAIN, httpOnly: true, sameSite: 'lax' });
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
