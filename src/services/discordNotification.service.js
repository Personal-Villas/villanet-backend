const DISCORD_WEBHOOK_ACCESS = process.env.DISCORD_WEBHOOK_ACCESS;
const DISCORD_WEBHOOK_QUOTES = process.env.DISCORD_WEBHOOK_QUOTES;
const TIMEOUT_MS = 5000;

// ✅ NUEVO: Cargar whitelist desde .env
const ACCESS_NOTIFICATION_WHITELIST = process.env.DISCORD_ACCESS_NOTIFICATION_WHITELIST
  ? process.env.DISCORD_ACCESS_NOTIFICATION_WHITELIST
      .split(',')
      .map(email => email.trim().toLowerCase())
  : [];

// Log de whitelist al iniciar el servicio (para debugging)
if (ACCESS_NOTIFICATION_WHITELIST.length > 0) {
  console.log(`📋 Discord Access Notification Whitelist loaded: ${ACCESS_NOTIFICATION_WHITELIST.length} emails`);
}

/**
 * ============================================
 * SERVICIO CENTRAL DE NOTIFICACIONES DISCORD
 * ============================================
 *
 * Solo maneja envío a Discord
 * Nunca interrumpe el flujo principal
 * Logs detallados para debugging
 * Funciones puras separadas de I/O
 */

/**
 * ✅ NUEVO: Verifica si un email está en la whitelist
 * @param {string} email - Email a verificar
 * @returns {boolean} true si está en whitelist (no debe notificar)
 */
function isEmailWhitelisted(email) {
  if (!email) return false;
  
  const normalizedEmail = String(email).toLowerCase().trim();
  const isWhitelisted = ACCESS_NOTIFICATION_WHITELIST.includes(normalizedEmail);
  
  if (isWhitelisted) {
    console.log(`🔇 Email in whitelist, skipping Discord notification: ${normalizedEmail}`);
  }
  
  return isWhitelisted;
}

/**
 * Core function para enviar a Discord con timeout y error handling robusto
 * @private
 */
async function sendToDiscord(webhookUrl, payload) {
  if (!webhookUrl) {
    console.warn("⚠️ Discord webhook not configured, skipping notification");
    return { success: false, reason: "webhook_not_configured" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Discord API error [${response.status}]:`, errorText);
      return { success: false, status: response.status, error: errorText };
    }

    console.log("✅ Discord notification sent successfully");
    return { success: true };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === "AbortError") {
      console.error("⏱️ Discord notification timeout");
      return { success: false, reason: "timeout" };
    }

    console.error("❌ Discord notification error:", error.message);
    return { success: false, reason: "network_error", error: error.message };
  }
}

/**
 * Helper para formatear timestamp en zona horaria de Canadá
 */
function formatTimestamp(date) {
  return new Date(date).toLocaleString("es-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "full",
    timeStyle: "medium",
  });
}

/**
 * ============================================
 * NOTIFICACIONES PÚBLICAS (API del servicio)
 * ============================================
 */

/**
 * Envía notificación de solicitud de código de acceso
 * @param {Object} data
 * @param {string} data.email - Email del usuario
 * @param {boolean} data.userExists - Si el usuario ya existe
 * @param {Date} data.timestamp - Timestamp de la solicitud
 * @returns {Promise<Object>} Resultado del envío
 */
export async function sendAccessNotification(data) {
  const { email, userExists, timestamp } = data;

  // ✅ NUEVO: Verificar whitelist
  if (isEmailWhitelisted(email)) {
    return { 
      success: false, 
      reason: 'email_whitelisted',
      message: 'Email in whitelist, notification skipped'
    };
  }

  const embed = {
    embeds: [
      {
        title: "🔐 NEW ACCESS REQUEST",
        color: userExists ? 0x3b82f6 : 0x10b981, // Azul si existe, verde si es nuevo
        fields: [
          {
            name: "📧 Email",
            value: email,
            inline: true,
          },
          {
            name: "👤 Status",
            value: userExists ? "User" : "*New User*",
            inline: true,
          },
          {
            name: "⏰ Timestamp",
            value: formatTimestamp(timestamp),
            inline: false,
          },
        ],
        footer: {
          text: "The Villa Net • Access System",
        },
        timestamp: new Date(timestamp).toISOString(),
      },
    ],
  };

  return sendToDiscord(DISCORD_WEBHOOK_ACCESS, embed);
}

/**
 * Envía notificación de cotización generada
 * @param {Object} data
 * @param {string} data.quoteId - ID de la cotización
 * @param {string} data.clientEmail - Email del cliente
 * @param {string} [data.clientName] - Nombre del cliente (opcional)
 * @param {Array} data.villas - Array de villas cotizadas
 * @param {string} data.checkIn - Fecha de check-in (YYYY-MM-DD)
 * @param {string} data.checkOut - Fecha de check-out (YYYY-MM-DD)
 * @param {number} [data.guests] - Número de huéspedes
 * @param {number} data.totalPrice - Precio total aproximado
 * @param {string} [data.downloadUrl] - URL para descargar cotización
 * @returns {Promise<Object>} Resultado del envío
 */
export async function sendQuoteNotification(data) {
  const {
    quoteId,
    clientEmail,
    clientName,
    villas,
    checkIn,
    checkOut,
    guests,
    totalPrice,
    downloadUrl,
  } = data;

  // Construir descripción de villas
  const villasDescription =
    villas.length === 1
      ? villas[0].name
      : `${villas.length} villas:\n${villas.map((v) => `• ${v.name}`).join("\n")}`;

  const fields = [
    {
      name: "📧 Client",
      value: clientName ? `${clientName} (${clientEmail})` : clientEmail,
      inline: false,
    },
    {
      name: "🏠 Villa(s)",
      value: villasDescription,
      inline: false,
    },
    {
      name: "💵 Estimated total price",
      value: `$${totalPrice.toLocaleString("es-CA", { minimumFractionDigits: 2 })} USD`,
      inline: true,
    },
    {
      name: "🆔 Quote ID",
      value: `#${quoteId}`,
      inline: true,
    },
  ];

  // Agregar fechas si están disponibles
  if (checkIn && checkOut) {
    fields.push({
      name: "📅 Dates",
      value: `${new Date(checkIn).toLocaleDateString("es-CA")} → ${new Date(checkOut).toLocaleDateString("es-CA")}`,
      inline: false,
    });
  }

  // Agregar huéspedes si está disponible
  if (guests) {
    fields.push({
      name: "👥 Guests",
      value: String(guests),
      inline: true,
    });
  }

  const embed = {
    embeds: [
      {
        title: "💰 New Quote",
        color: 0xf59e0b, // Naranja/dorado
        description: `A new quote was generated for ${villas.length} ${villas.length === 1 ? "villa" : "villas"}`,
        fields,
        footer: {
          text: "The Villa Net • Quote System",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  return sendToDiscord(DISCORD_WEBHOOK_QUOTES, embed);
}

/**
 * Wrapper genérico para ejecutar notificaciones de forma segura
 * Garantiza que nunca interrumpa el flujo principal
 *
 * Uso:
 *   notifySafely(() => sendAccessNotification(data));
 *   notifySafely(() => sendQuoteNotification(data));
 */
export function notifySafely(notificationFn) {
  Promise.resolve()
    .then(() => notificationFn())
    .catch((error) => {
      console.error(
        "🔕 Discord notification failed (non-blocking):",
        error.message,
      );
    });
}