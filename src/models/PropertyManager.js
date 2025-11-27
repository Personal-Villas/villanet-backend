// src/models/PropertyManager.js
import { pool } from '../db.js';

export class PropertyManager {
  /**
   * Busca un PM por email
   * @param {string} email
   * @returns {Promise<object|null>}
   */
  static async findByEmail(email) {
    const normalizedEmail = email.toLowerCase();

    const query = `
      SELECT
        id,
        company_name,
        contact_name,
        email,
        website,
        locations,
        status,
        submitted_at,
        created_at,
        updated_at
      FROM property_managers
      WHERE email = $1
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [normalizedEmail]);
    return rows[0] || null;
  }

  /**
   * Crea un nuevo PM
   * @param {object} data
   * @returns {Promise<object>}
   */
  static async create(data) {
    // Por si locations viene como array
    const locationsValue = Array.isArray(data.locations)
      ? data.locations.join(', ')
      : data.locations;

    const query = `
      INSERT INTO property_managers (
        company_name,
        contact_name,
        email,
        website,
        locations,
        status,
        submitted_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id,
        company_name,
        contact_name,
        email,
        website,
        locations,
        status,
        submitted_at,
        created_at,
        updated_at
    `;

    const values = [
      data.company_name,
      data.contact_name,
      data.email.toLowerCase(),
      data.website || null,
      locationsValue,
      data.status || 'pending',
      data.submitted_at || new Date().toISOString(),
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
  }

  /**
   * (Opcional) actualizar estado más adelante
   */
  static async updateStatus(id, status) {
    const query = `
      UPDATE property_managers
      SET status = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const { rows } = await pool.query(query, [id, status]);
    return rows[0] || null;
  }
}
