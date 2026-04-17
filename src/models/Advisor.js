import { pool } from '../db.js';

export const Advisor = {
  // Crear un nuevo advisor
  async create(advisorData) {
    const {
      first_name,
      last_name,
      email,
      password_hash,
      advisor_type,
      travel_regions,
      typical_group_size,
      villa_budget_range,
      commission_preference,
      website,
      agreed_to_terms,
      profile_completion_percentage,
      preferred_currency
    } = advisorData;

    const query = `
      INSERT INTO advisors (
        first_name, last_name, email, password_hash, advisor_type, 
        travel_regions, typical_group_size, villa_budget_range, 
        commission_preference, website, agreed_to_terms, 
        profile_completion_percentage, signup_completed_at, preferred_currency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, first_name, last_name, email, advisor_type, profile_completion_percentage, preferred_currency
    `;

    const values = [
      first_name,
      last_name,
      email,
      password_hash,
      advisor_type,
      travel_regions,
      typical_group_size,
      villa_budget_range,
      commission_preference,
      website,
      agreed_to_terms,
      profile_completion_percentage,
      new Date().toISOString(),
      preferred_currency ?? 'USD'
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error creating advisor:', error);
      throw error;
    }
  },

  // Verificar si el email ya existe
  async findByEmail(email) {
    const query = 'SELECT id, email FROM advisors WHERE email = $1';
    const result = await pool.query(query, [email]);
    return result.rows[0];
  },

  // Obtener advisor por ID
  async findById(id) {
    const query = 'SELECT * FROM advisors WHERE id = $1';
    const result = await pool.query(query, [id]);
    return result.rows[0];
  },

  // Obtener perfil completo del advisor (join con users para avatar_url)
  async getProfileByEmail(email) {
    const query = `
      SELECT 
        a.id, a.first_name, a.last_name, a.email,
        a.advisor_type, a.travel_regions, a.typical_group_size,
        a.villa_budget_range, a.commission_preference, a.website,
        a.profile_completion_percentage, a.created_at,
        u.avatar_url, u.full_name, u.id AS user_id, a.preferred_currency as preferred_currency
      FROM advisors a
      LEFT JOIN users u ON u.email = a.email
      WHERE a.email = $1
    `;
    const result = await pool.query(query, [email]);
    return result.rows[0];
  },

  // Actualizar campos editables del advisor
  async updateProfile(email, { website, preferred_currency }) {
    const query = `
      UPDATE advisors
      SET website           = COALESCE($2, website),
          preferred_currency = COALESCE($3, preferred_currency),
          updated_at        = NOW()
      WHERE email = $1
      RETURNING id, first_name, last_name, email, advisor_type,
                travel_regions, typical_group_size, villa_budget_range,
                commission_preference, website, profile_completion_percentage, preferred_currency
    `;
    const result = await pool.query(query, [email, website ?? null, preferred_currency ?? null]);
    return result.rows[0];
  }
};