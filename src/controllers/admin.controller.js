import { pool } from '../db.js';

export const AdminController = {
  async listUsers(_req, res) {
    const { rows } = await pool.query(`
      SELECT id,email,full_name,role,status,trial_expires_at,created_at
      FROM users ORDER BY created_at DESC`);
    res.json(rows);
  },

  async approve(req, res) {
    const { userId } = req.params;
    await pool.query(`UPDATE users SET status='approved', updated_at=now() WHERE id=$1`, [userId]);
    res.json({ ok: true });
  },

  async reject(req, res) {
    const { userId } = req.params;
    await pool.query(`UPDATE users SET status='rejected', updated_at=now() WHERE id=$1`, [userId]);
    res.json({ ok: true });
  }
};
