import { Advisor } from '../models/Advisor.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export const advisorsController = {
    async signup(req, res) {
      try {
        const {
          first_name,
          last_name,
          email,
          password,
          advisor_type,
          travel_regions,
          typical_group_size,
          villa_budget_range,
          commission_preference,
          website,
          agreed_to_terms,
          profile_completion_percentage
        } = req.body;
  
        // Validaciones básicas
        if (!first_name || !last_name || !email || !password) {
          return res.status(400).json({
            success: false,
            message: 'First name, last name, email and password are required'
          });
        }
  
        // Verificar si el email ya existe
        const existingAdvisor = await Advisor.findByEmail(email);
        if (existingAdvisor) {
          return res.status(409).json({
            success: false,
            message: 'An advisor with this email already exists'
          });
        }
  
        // Hash de la contraseña
        const saltRounds = 12;
        const password_hash = await bcrypt.hash(password, saltRounds);
  
        // Preparar datos para la base de datos
        const advisorData = {
          first_name,
          last_name,
          email: email.toLowerCase(),
          password_hash,
          advisor_type: advisor_type || null,
          travel_regions: travel_regions || [],
          typical_group_size: typical_group_size || null,
          villa_budget_range: villa_budget_range || null,
          commission_preference: commission_preference || null,
          website: website || null,
          agreed_to_terms: agreed_to_terms || false,
          profile_completion_percentage: profile_completion_percentage || 20
        };
  
        // Crear el advisor en la base de datos
        const newAdvisor = await Advisor.create(advisorData);
  
        // Generar token JWT
        const token = jwt.sign(
          { 
            id: newAdvisor.id, 
            email: newAdvisor.email,
            role: 'ta' // Travel Advisor
          },
          process.env.JWT_SECRET || 'your-secret-key',
          { expiresIn: '24h' }
        );
  
        // Eliminar información sensible de la respuesta
        const { password_hash: _, ...advisorResponse } = newAdvisor;
  
        res.status(201).json({
          success: true,
          message: 'Advisor created successfully',
          accessToken: token, // 🆕 Incluir token
          user: {
            id: newAdvisor.id,
            email: newAdvisor.email,
            role: 'ta',
            status: 'approved', // Los advisors se aprueban automáticamente
            full_name: `${first_name} ${last_name}`
          },
          advisorId: newAdvisor.id
        });
  
      } catch (error) {
        console.error('Advisor signup error:', error);
        
        if (error.code === '23505') {
          return res.status(409).json({
            success: false,
            message: 'An advisor with this email already exists'
          });
        }
  
        res.status(500).json({
          success: false,
          message: 'Internal server error during advisor registration'
        });
      }
    }
  };