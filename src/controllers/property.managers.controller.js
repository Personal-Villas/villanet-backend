import { PropertyManager } from '../models/PropertyManager.js';

export const propertyManagersController = {
  async signup(req, res) {
    try {
      const {
        company_name,
        contact_name,
        email,
        website,
        locations
      } = req.body;

      // Validaciones básicas
      if (!company_name || !contact_name || !email || !locations) {
        return res.status(400).json({
          success: false,
          message: 'Company name, contact name, email and locations are required'
        });
      }

      // Verificar si el email ya existe
      const existingManager = await PropertyManager.findByEmail(email);
      if (existingManager) {
        return res.status(409).json({
          success: false,
          message: 'A property manager with this email already exists'
        });
      }

      // Preparar datos para la base de datos
      const managerData = {
        company_name,
        contact_name,
        email: email.toLowerCase(),
        website: website || null,
        locations,
        status: 'pending', // Todos los PMs empiezan como pendientes
        submitted_at: new Date().toISOString()
      };

      // Crear el property manager en la base de datos
      const newManager = await PropertyManager.create(managerData);

      res.status(201).json({
        success: true,
        message: 'Property manager application submitted successfully',
        managerId: newManager.id
      });

    } catch (error) {
      console.error('Property manager signup error:', error);
      
      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'A property manager with this email already exists'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error during property manager registration'
      });
    }
  }
};