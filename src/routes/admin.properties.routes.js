import { Router } from 'express';
import { pool } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const r = Router();

/**
 * GET /admin/properties
 * Query params:
 *   - page: número de página (default: 1)
 *   - limit: items por página (default: 50, max: 200)
 *   - search: texto para buscar en name, city, country
 *   - sort_by: 'name' | 'date' (default: 'name')
 *   - sort_order: 'asc' | 'desc' (default: 'asc')
 * 
 * Response: { results: [...], total: number, page: number, limit: number }
 */
r.get('/', auth(true), requireRole('admin','pmc'), async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      
      const search = (req.query.search || '').toString().trim();
      const sortBy = req.query.sort_by === 'date' ? 'date' : 'name';
      const sortOrder = req.query.sort_order === 'desc' ? 'DESC' : 'ASC';
      const showAll = req.query.show_all === 'true'; // Nuevo parámetro
  
      const params = [];
      const clauses = [];
  
      // Solo filtrar por listed si NO se pide ver todo
      if (!showAll) {
        clauses.push(`COALESCE(is_listed, TRUE) = TRUE`);
      }
      
      if (search) {
        params.push(`%${search}%`);
        clauses.push(`(
          name ILIKE $${params.length}
          OR city ILIKE $${params.length}
          OR country ILIKE $${params.length}
        )`);
      }
  
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      
      const orderColumn = sortBy === 'date' ? 'updated_at' : 'name';
  
      const countSql = `
        SELECT COUNT(*) as total
        FROM public.listings
        ${where}
      `;
      
      const countResult = await pool.query(countSql, params);
      const total = parseInt(countResult.rows[0].total);
  
      const dataSql = `
        SELECT
          listing_id AS id,
          COALESCE(name, 'Untitled') AS name,
          NULLIF(TRIM(CONCAT_WS(', ', city, country)), '') AS address,
          updated_at AS created_at,
          is_listed -- Incluir este campo para debug
        FROM public.listings
        ${where}
        ORDER BY ${orderColumn} ${sortOrder}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      
      params.push(limit, offset);
      const { rows } = await pool.query(dataSql, params);
  
      res.json({
        results: rows,
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
        show_all: showAll // Para confirmar en response
      });
  
    } catch (error) {
      console.error('Error in /admin/properties:', error);
      res.status(500).json({ 
        error: 'Failed to fetch properties',
        message: error.message 
      });
    }
  });

export default r;