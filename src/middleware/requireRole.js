import { pool } from '../db.js';

export function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Auth required' });
    
    try {
      let userRole;
      
      // Si ya tenemos el rol en el token, lo usamos
      if (req.user.role) {
        userRole = req.user.role;
      }
      // Si no, consultamos la base de datos
      else if (req.user.sub) {
        const { rows } = await pool.query(
          'SELECT role FROM users WHERE id = $1',
          [req.user.sub]
        );
        
        if (rows.length === 0) {
          return res.status(404).json({ message: 'User not found' });
        }
        
        userRole = rows[0].role;
        
        // Opcional: actualizar req.user con el rol real
        req.user.role = userRole;
      }
      else {
        return res.status(403).json({ message: 'Unable to determine user role' });
      }
      
      console.log('🔐 User role:', userRole);
      console.log('🔐 Required roles:', roles);
      
      if (!roles.includes(userRole)) {
        return res.status(403).json({ 
          message: 'Forbidden',
          required: roles,
          current: userRole
        });
      }
      
      next();
    } catch (error) {
      console.error('Error checking user role:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  };
}