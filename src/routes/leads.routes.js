import express from 'express';
import { pool } from '../db.js'; 
import { sendExpansionLeadNotification } from '../services/email.service.js';

const router = express.Router();

/**
 * POST /api/leads/expansion-request
 * Crea un lead de expansión de búsqueda
 * Endpoint PÚBLICO - no requiere autenticación
 */
router.post('/expansion-request', async (req, res) => {
  let client;
  
  try {
    const {
      fullName,
      email,
      location,
      checkIn,
      checkOut,
      bedrooms,
      bathrooms,
      minPrice,
      maxPrice,
      guests,
      amenities,
      currentResultsCount,
      searchContext,
    } = req.body;

    // Validación básica - nombre y email son requeridos
    if (!fullName || !fullName.trim()) {
      return res.status(400).json({
        error: 'Full name is required',
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        error: 'Email is required',
      });
    }

    // Validación de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email address',
      });
    }

    // Validación de preferencias de búsqueda
    if (!location && !checkIn && !checkOut) {
      return res.status(400).json({
        error: 'Please provide at least a location or dates',
      });
    }

    // Obtener user_id si está autenticado (opcional)
    let userId = null;

    // Si hay token JWT en req.user (middleware de auth)
    if (req.user) {
      userId = req.user.id;
    }

    // Convertir arrays a string para guardar
    const bedroomsStr = Array.isArray(bedrooms) 
      ? bedrooms.join(',') 
      : bedrooms || null;
    
    const bathroomsStr = Array.isArray(bathrooms) 
      ? bathrooms.join(',') 
      : bathrooms || null;
    
    const amenitiesJson = JSON.stringify(amenities || []);
    const searchContextJson = JSON.stringify(searchContext || {});

    // Obtener cliente del pool compartido
    client = await pool.connect();

    // Insertar en la base de datos
    const query = `
      INSERT INTO expansion_leads (
        user_id,
        user_email,
        full_name,
        location,
        check_in,
        check_out,
        bedrooms,
        bathrooms,
        min_price,
        max_price,
        guests,
        amenities,
        current_results_count,
        search_context,
        status,
        source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, created_at
    `;

    const values = [
      userId,
      email.trim().toLowerCase(),
      fullName.trim(),
      location || null,
      checkIn || null,
      checkOut || null,
      bedroomsStr,
      bathroomsStr,
      minPrice ? parseFloat(minPrice) : null,
      maxPrice ? parseFloat(maxPrice) : null,
      guests ? parseInt(guests) : null,
      amenitiesJson,
      currentResultsCount ? parseInt(currentResultsCount) : null,
      searchContextJson,
      'pending',
      'web',
    ];

    const result = await client.query(query, values);
    const { id: leadId, created_at } = result.rows[0];

    console.log(`✅ Expansion lead created: ID ${leadId} - ${fullName} (${email})`);

    // Liberar cliente del pool
    client.release();

    // Enviar email al equipo (no bloqueante)
    sendExpansionLeadNotification({
      full_name: fullName.trim(),
      user_email: email.trim().toLowerCase(),
      location,
      check_in: checkIn,
      check_out: checkOut,
      bedrooms: bedroomsStr,
      bathrooms: bathroomsStr,
      min_price: minPrice,
      max_price: maxPrice,
      guests,
      amenities: amenitiesJson,
      current_results_count: currentResultsCount,
    }).catch((emailError) => {
      console.error('❌ Error sending email notification:', emailError);
      // No fallar la request si el email falla
    });

    res.status(201).json({
      success: true,
      message: 'Your request has been received. We\'ll get back to you soon!',
      leadId,
      createdAt: created_at,
    });
  } catch (error) {
    console.error('❌ Error creating expansion lead:', error);
    
    // Liberar cliente si hay error
    if (client) {
      client.release();
    }
    
    // Error de base de datos
    if (error.code) {
      // Errores específicos de PostgreSQL
      if (error.code === '28000') {
        return res.status(500).json({
          error: 'Database authentication error. Please contact support.',
        });
      }
      
      if (error.code === 'ENOTFOUND') {
        return res.status(500).json({
          error: 'Database connection error. Please try again later.',
        });
      }

      return res.status(500).json({
        error: 'Database error. Please try again.',
        code: error.code,
      });
    }

    res.status(500).json({
      error: 'Failed to process your request. Please try again.',
    });
  }
});

/**
 * GET /api/leads/expansion-requests
 * Lista todos los expansion leads (para admin)
 * Requiere autenticación de admin
 */
router.get('/expansion-requests', async (req, res) => {
  let client;
  
  try {
    // TODO: Agregar middleware de autenticación admin aquí
    // if (!req.user || req.user.role !== 'admin') {
    //   return res.status(403).json({ error: 'Unauthorized' });
    // }

    const { status, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT 
        id,
        user_id,
        user_email,
        full_name,
        location,
        check_in,
        check_out,
        bedrooms,
        bathrooms,
        min_price,
        max_price,
        guests,
        amenities,
        current_results_count,
        status,
        source,
        created_at,
        updated_at,
        contacted_at
      FROM expansion_leads
    `;

    const values = [];
    const conditions = [];

    if (status) {
      conditions.push(`status = $${values.length + 1}`);
      values.push(status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(parseInt(limit), parseInt(offset));

    client = await pool.connect();
    const result = await client.query(query, values);

    // Contar total
    const countQuery = conditions.length > 0
      ? `SELECT COUNT(*) FROM expansion_leads WHERE ${conditions.join(' AND ')}`
      : `SELECT COUNT(*) FROM expansion_leads`;
    
    const countValues = conditions.length > 0 ? values.slice(0, conditions.length) : [];
    const countResult = await client.query(countQuery, countValues);
    const total = parseInt(countResult.rows[0].count);

    client.release();

    res.json({
      success: true,
      leads: result.rows,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('❌ Error fetching expansion leads:', error);
    
    if (client) {
      client.release();
    }
    
    res.status(500).json({
      error: 'Failed to fetch leads',
    });
  }
});

/**
 * PATCH /api/leads/expansion-requests/:id
 * Actualiza el estado de un lead (para admin)
 */
router.patch('/expansion-requests/:id', async (req, res) => {
  let client;
  
  try {
    // TODO: Agregar middleware de autenticación admin aquí

    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'contacted', 'converted', 'expired'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        validStatuses,
      });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;

      if (status === 'contacted') {
        updates.push(`contacted_at = CURRENT_TIMESTAMP`);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No updates provided',
      });
    }

    values.push(id);

    const query = `
      UPDATE expansion_leads
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    client = await pool.connect();
    const result = await client.query(query, values);
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Lead not found',
      });
    }

    res.json({
      success: true,
      lead: result.rows[0],
    });
  } catch (error) {
    console.error('❌ Error updating expansion lead:', error);
    
    if (client) {
      client.release();
    }
    
    res.status(500).json({
      error: 'Failed to update lead',
    });
  }
});

export default router;