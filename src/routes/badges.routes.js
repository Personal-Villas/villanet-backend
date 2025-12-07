import { Router } from 'express';
import { pool } from '../db.js';         
import { auth } from '../middleware/auth.js'; 

const r = Router();

// 🔥 Mapeo de nombres de campo a nombres de badge e íconos
const FIELD_TO_BADGE_MAP = {
  // Formato: campo_en_bd: { nombre, slug, icono, es_quick, orden }
  villanet_chef_included: {
    name: 'Chef Included',
    slug: 'chef-included',
    icon: 'chef-hat',
    is_quick: true,
    sort_order: 1,
    description: 'Professional chef included with your stay'
  },
  villanet_true_beach_front: {
    name: 'True Beach Front',
    slug: 'true-beach-front',
    icon: 'waves',
    is_quick: true,
    sort_order: 2,
    description: 'Villa is directly on the beach'
  },
  villanet_gated_community: {
    name: 'Gated Enclave',
    slug: 'gated-community',
    icon: 'shield',
    is_quick: true,
    sort_order: 3,
    description: 'Located in a secure gated community'
  },
  villanet_cook_included: {
    name: 'Cook Included',
    slug: 'cook-included',
    icon: 'utensils-crossed',
    is_quick: false,
    sort_order: 4,
    description: 'Personal cook service included'
  },
  villanet_ocean_front: {
    name: 'Ocean Front',
    slug: 'ocean-front',
    icon: 'eye',
    is_quick: true,
    sort_order: 5,
    description: 'Direct ocean front property'
  },
  villanet_ocean_view: {
    name: 'Ocean View',
    slug: 'ocean-view',
    icon: 'eye',
    is_quick: true,
    sort_order: 6,
    description: 'Panoramic ocean views'
  },
  villanet_walk_to_beach: {
    name: 'Walk to the Beach',
    slug: 'walk-to-beach',
    icon: 'waves',
    is_quick: false,
    sort_order: 7,
    description: 'Short walking distance to the beach'
  },
  villanet_resort_villa: {
    name: 'Resort Villa',
    slug: 'resort-villa',
    icon: 'sparkles',
    is_quick: false,
    sort_order: 8,
    description: 'Part of a luxury resort complex'
  },
  villanet_golf_villa: {
    name: 'Golf Villa',
    slug: 'golf-villa',
    icon: 'flag',
    is_quick: false,
    sort_order: 9,
    description: 'Located on a golf course'
  },
  villanet_private_gym: {
    name: 'Private Gym',
    slug: 'private-gym',
    icon: 'dumbbell',
    is_quick: false,
    sort_order: 10,
    description: 'Private gym facility'
  },
  villanet_private_cinema: {
    name: 'Private Cinema',
    slug: 'private-cinema',
    icon: 'film',
    is_quick: false,
    sort_order: 11,
    description: 'Private home cinema'
  },
  villanet_pickleball: {
    name: 'Pickleball',
    slug: 'pickleball',
    icon: 'tennis',
    is_quick: false,
    sort_order: 12,
    description: 'Pickleball court available'
  },
  villanet_tennis: {
    name: 'Tennis',
    slug: 'tennis',
    icon: 'tennis',
    is_quick: false,
    sort_order: 13,
    description: 'Tennis court available'
  },
  villanet_golf_cart_included: {
    name: 'Golf Cart Included',
    slug: 'golf-cart-included',
    icon: 'car',
    is_quick: false,
    sort_order: 14,
    description: 'Golf cart included with rental'
  },
  villanet_heated_pool: {
    name: 'Heated Pool',
    slug: 'heated-pool',
    icon: 'droplets',
    is_quick: false,
    sort_order: 15,
    description: 'Heated swimming pool'
  },
  villanet_waiter_butler_included: {
    name: 'Waiter/Butler Included',
    slug: 'waiter-butler-included',
    icon: 'user-check',
    is_quick: false,
    sort_order: 16,
    description: 'Dedicated waiter or butler service'
  },
  villanet_accessible: {
    name: 'Accessible',
    slug: 'accessible',
    icon: 'wheelchair',
    is_quick: false,
    sort_order: 17,
    description: 'Wheelchair accessible property'
  }
};

// 🔥 GET /badges - Badges dinámicos basados en campos booleanos existentes
r.get('/', auth(false), async (_req, res) => {
  try {
    // 1. 🔍 Detectar qué campos booleanos de villanet existen en la tabla listings
    const { rows: existingColumns } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_name = 'listings' 
        AND table_schema = 'public'
        AND column_name LIKE 'villanet_%'
        AND data_type = 'boolean'
      ORDER BY column_name;
    `);

    console.log('📊 Campos booleanos VillaNet detectados:', existingColumns);

    // 2. 🔥 Crear badges solo para los campos que existen
    const dynamicBadges = existingColumns
      .map(col => {
        const fieldName = col.column_name;
        const badgeConfig = FIELD_TO_BADGE_MAP[fieldName];
        
        if (badgeConfig) {
          return {
            id: badgeConfig.slug, // Usar slug como ID
            name: badgeConfig.name,
            slug: badgeConfig.slug,
            icon: badgeConfig.icon,
            is_quick: badgeConfig.is_quick,
            sort_order: badgeConfig.sort_order,
            description: badgeConfig.description,
            field_name: fieldName,
            is_dynamic: true
          };
        } else {
          // Si no está en el mapeo, crear un badge genérico
          const name = fieldName
            .replace('villanet_', '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
          
          return {
            id: fieldName,
            name: name,
            slug: fieldName.replace('villanet_', '').replace(/_/g, '-'),
            icon: 'sparkles',
            is_quick: false,
            sort_order: 999,
            description: `${name} available`,
            field_name: fieldName,
            is_dynamic: true
          };
        }
      })
      .sort((a, b) => a.sort_order - b.sort_order);

    // 3. Verificar si hay al menos una propiedad con cada campo true
    const badgesWithCounts = await Promise.all(
      dynamicBadges.map(async (badge) => {
        const { rows: countResult } = await pool.query(`
          SELECT COUNT(*) as count
          FROM listings 
          WHERE ${badge.field_name} = true 
            AND is_listed = true 
            AND villanet_enabled = true
        `);
        
        const count = parseInt(countResult[0].count) || 0;
        
        return {
          ...badge,
          property_count: count,
          // Si no hay propiedades con este campo, no lo mostramos como badge activo
          active: count > 0
        };
      })
    );

    // 4. Filtrar solo badges que tienen al menos una propiedad
    const activeBadges = badgesWithCounts
      .filter(badge => badge.active)
      .map(({ active, ...badge }) => badge); // Eliminar campo "active" del resultado

    console.log(`🎯 Badges activos encontrados: ${activeBadges.length} de ${dynamicBadges.length}`);

    // 5. Devolver respuesta
    res.json({
      badges: activeBadges,
      meta: {
        total_badges: activeBadges.length,
        fields_detected: existingColumns.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (err) {
    console.error('❌ Error fetching dynamic badges:', err);
    res.status(500).json({ 
      message: 'Error fetching badges',
      error: err.message 
    });
  }
});

export default r;