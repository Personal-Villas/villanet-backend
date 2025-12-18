import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// POST: Create a new Early Access request
router.post('/', async (req, res) => {
  let client;
  try {
    const { name, email, linkedin, agency } = req.body;

    // Basic validations
    if (!name || !email) {
      return res.status(400).json({ 
        error: 'Name and email are required',
        message: 'Please provide your name and email address.' 
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format',
        message: 'Please provide a valid email address.' 
      });
    }

    client = await pool.connect();

    // Check if a request with this email already exists
    const existingRequestResult = await client.query(
      'SELECT id FROM early_access_requests WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingRequestResult.rows.length > 0) {
      return res.status(409).json({ 
        error: 'A request with this email already exists',
        message: 'We already have your request. We\'ll contact you soon.' 
      });
    }

    // Insert the new request
    const newRequestResult = await client.query(
      `INSERT INTO early_access_requests 
       (name, email, linkedin_url, agency) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name, email, linkedin_url, agency, status, created_at`,
      [
        name.trim(),
        email.toLowerCase().trim(),
        linkedin ? linkedin.trim() : null,
        agency ? agency.trim() : null
      ]
    );

    const newRequest = newRequestResult.rows[0];

    console.log('📝 New Early Access request:', newRequest.email);

    res.status(201).json({
      message: 'Request submitted successfully',
      request: newRequest
    });

  } catch (error) {
    console.error('Error processing Early Access request:', error);
    
    // Handle database errors
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({ 
        error: 'Duplicate entry',
        message: 'A request with this email already exists.'
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'An error occurred while processing your request. Please try again later.' 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// GET: Get all requests (admin only)
router.get('/', async (req, res) => {
  let client;
  try {
    // TODO: Add authentication and admin role check
    // const user = req.user;
    // if (!user || user.role !== 'admin') {
    //   return res.status(403).json({ error: 'Forbidden' });
    // }

    client = await pool.connect();

    const requestsResult = await client.query(
      `SELECT * FROM early_access_requests 
       ORDER BY created_at DESC`
    );

    res.json(requestsResult.rows);
  } catch (error) {
    console.error('Error fetching Early Access requests:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch requests.' 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// GET: Get a specific request by ID (admin only)
router.get('/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    // TODO: Add authentication and admin role check

    client = await pool.connect();

    const requestResult = await client.query(
      'SELECT * FROM early_access_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'Request not found.' 
      });
    }

    res.json(requestResult.rows[0]);
  } catch (error) {
    console.error('Error fetching Early Access request:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch request.' 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// PATCH: Update request status (admin only)
router.patch('/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { status, notes, reviewed_by } = req.body;

    // TODO: Add authentication and admin role check
    // const user = req.user;
    // if (!user || user.role !== 'admin') {
    //   return res.status(403).json({ error: 'Forbidden' });
    // }

    // Validate status
    const validStatuses = ['pending', 'approved', 'rejected'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status',
        message: `Status must be one of: ${validStatuses.join(', ')}` 
      });
    }

    client = await pool.connect();

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (status) {
      updates.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramCount}`);
      values.push(notes || null);
      paramCount++;
    }

    if (reviewed_by) {
      updates.push(`reviewed_by = $${paramCount}`);
      values.push(reviewed_by);
      paramCount++;
    }

    updates.push(`reviewed_at = NOW()`);

    if (updates.length === 0) {
      return res.status(400).json({ 
        error: 'No updates provided',
        message: 'Please provide at least one field to update.' 
      });
    }

    values.push(id);

    const updateResult = await client.query(
      `UPDATE early_access_requests 
       SET ${updates.join(', ')} 
       WHERE id = $${paramCount} 
       RETURNING *`,
      values
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'Request not found.' 
      });
    }

    res.json(updateResult.rows[0]);
  } catch (error) {
    console.error('Error updating Early Access request:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to update request.' 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// DELETE: Delete a request (admin only)
router.delete('/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    // TODO: Add authentication and admin role check

    client = await pool.connect();

    const deleteResult = await client.query(
      'DELETE FROM early_access_requests WHERE id = $1 RETURNING id',
      [id]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'Request not found.' 
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Early Access request:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to delete request.' 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

export default router;