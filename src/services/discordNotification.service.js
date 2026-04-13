const DISCORD_WEBHOOK_ACCESS = process.env.DISCORD_WEBHOOK_ACCESS;
const DISCORD_WEBHOOK_QUOTES = process.env.DISCORD_WEBHOOK_QUOTES;
const DISCORD_WEBHOOK_SYNC   = process.env.DISCORD_WEBHOOK_SYNC;
const DISCORD_WEBHOOK_INQUIRIES = process.env.DISCORD_WEBHOOK_INQUIRIES;


const TIMEOUT_MS = 5000;

const ACCESS_NOTIFICATION_WHITELIST = process.env.DISCORD_ACCESS_NOTIFICATION_WHITELIST
  ? process.env.DISCORD_ACCESS_NOTIFICATION_WHITELIST
      .split(',')
      .map(email => email.trim().toLowerCase())
  : [];

if (ACCESS_NOTIFICATION_WHITELIST.length > 0) {
  console.log(`📋 Discord Access Notification Whitelist loaded: ${ACCESS_NOTIFICATION_WHITELIST.length} emails`);
}

function isEmailWhitelisted(email) {
  if (!email) return false;
  const normalizedEmail = String(email).toLowerCase().trim();
  const isWhitelisted = ACCESS_NOTIFICATION_WHITELIST.includes(normalizedEmail);
  if (isWhitelisted) {
    console.log(`🔇 Email in whitelist, skipping Discord notification: ${normalizedEmail}`);
  }
  return isWhitelisted;
}

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

function formatTimestamp(date) {
  return new Date(date).toLocaleString("es-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "full",
    timeStyle: "medium",
  });
}

// ─── Notificacion de Acceso ────────────────────────────────────────────────

export async function sendAccessNotification(data) {
  const { email, userExists, timestamp } = data;

  if (isEmailWhitelisted(email)) {
    return { success: false, reason: 'email_whitelisted' };
  }

  const embed = {
    embeds: [{
      title: "🔐 NEW ACCESS REQUEST",
      color: userExists ? 0x3b82f6 : 0x10b981,
      fields: [
        { name: "📧 Email",     value: email,                                  inline: true },
        { name: "👤 Status",    value: userExists ? "User" : "*New User*",     inline: true },
        { name: "⏰ Timestamp", value: formatTimestamp(timestamp),             inline: false },
      ],
      footer: { text: "The Villa Net • Access System" },
      timestamp: new Date(timestamp).toISOString(),
    }],
  };

  return sendToDiscord(DISCORD_WEBHOOK_ACCESS, embed);
}

// ─── Notificacion de Quote Generada ────────────────────────────────────────────────

export async function sendQuoteNotification(data) {
  const { quoteId, clientEmail, clientName, villas, checkIn, checkOut, guests, totalPrice } = data;

  const villasDescription =
    villas.length === 1
      ? villas[0].name
      : `${villas.length} villas:\n${villas.map((v) => `• ${v.name}`).join("\n")}`;

  const fields = [
    { name: "📧 Client",  value: clientName ? `${clientName} (${clientEmail})` : clientEmail, inline: false },
    { name: "🏠 Villa(s)", value: villasDescription, inline: false },
    { name: "💵 Estimated total price", value: `$${totalPrice.toLocaleString("es-CA", { minimumFractionDigits: 2 })} USD`, inline: true },
    { name: "🆔 Quote ID", value: `#${quoteId}`, inline: true },
  ];

  if (checkIn && checkOut) {
    fields.push({
      name: "📅 Dates",
      value: `${new Date(checkIn).toLocaleDateString("es-CA")} → ${new Date(checkOut).toLocaleDateString("es-CA")}`,
      inline: false,
    });
  }
  if (guests) fields.push({ name: "👥 Guests", value: String(guests), inline: true });

  const embed = {
    embeds: [{
      title: "💰 New Quote",
      color: 0xf59e0b,
      description: `A new quote was generated for ${villas.length} ${villas.length === 1 ? "villa" : "villas"}`,
      fields,
      footer: { text: "The Villa Net • Quote System" },
      timestamp: new Date().toISOString(),
    }],
  };

  return sendToDiscord(DISCORD_WEBHOOK_QUOTES, embed);
}

// ─── Alerta de fallo crítico de sync_availability ─────────────────────────────────────

/**
 * Envía alerta a Discord cuando la sincronización falla completamente.
 * @param {Object} data
 * @param {string} data.status       - 'failed'
 * @param {number} data.total        - Total de propiedades intentadas
 * @param {number} data.errors       - Cantidad de errores
 * @param {number} data.duration_s   - Duración en segundos
 * @param {string} data.message      - Mensaje de error
 */
export async function sendSyncErrorNotification(data) {
  const { status, total, errors, duration_s, message } = data;

  const embed = {
    embeds: [{
      title: "🔴 SYNC AVAILABILITY — FALLO CRÍTICO",
      color: 0xef4444, 
      description: "El proceso de sincronización de disponibilidad falló completamente.",
      fields: [
        { name: "❌ Status",      value: status,              inline: true  },
        { name: "🏠 Total",       value: String(total),       inline: true  },
        { name: "✖ Errores",     value: String(errors),      inline: true  },
        { name: "⏱ Duración",    value: `${duration_s}s`,    inline: true  },
        { name: "⏰ Timestamp",   value: formatTimestamp(new Date()), inline: false },
        { name: "📋 Detalle",     value: `\`\`\`${String(message).slice(0, 900)}\`\`\``, inline: false },
      ],
      footer: { text: "The Villa Net • Sync System" },
      timestamp: new Date().toISOString(),
    }],
  };

  return sendToDiscord(DISCORD_WEBHOOK_SYNC, embed);
}

// ─── Wrapper genérico seguro ──────────────────────────────────────────────────

export function notifySafely(notificationFn) {
  Promise.resolve()
    .then(() => notificationFn())
    .catch((error) => {
      console.error("🔕 Discord notification failed (non-blocking):", error.message);
    });
}
// ─── Notificacion de Consulta de Villa ────────────────────────────────────────

/**
 * Envía a Discord una notificación cuando un usuario usa el formulario
 * "Ask about this villa" en Properties o PropertyDetail.
 *
 * @param {Object} data
 * @param {string} data.villaId       - ID de la villa
 * @param {string} data.villaName     - Nombre de la villa
 * @param {string} data.message       - Texto de la consulta
 * @param {string} [data.clientEmail] - Email del usuario (si está logueado)
 * @param {string} [data.clientName]  - Nombre del usuario (si está disponible)
 * @param {string} [data.villaUrl]    - URL completa a la página de la villa
 */
export async function sendInquiryNotification(data) {
  const { villaId, villaName, message, clientEmail, clientName, villaUrl } = data;

  const clientDisplay = clientName
    ? `${clientName}${clientEmail ? ` (${clientEmail})` : ''}`
    : clientEmail || 'Anonymous';

  const villaLink = villaUrl || `https://thevillanet.com/property/${villaId}`;

  const embed = {
    embeds: [{
      title: '💬 New Villa Inquiry',
      color: 0x6366f1, // indigo
      description: `A visitor sent a question about **${villaName}**.`,
      fields: [
        { name: '🏠 Villa',    value: `[${villaName}](${villaLink})`, inline: true  },
        { name: '👤 Client',   value: clientDisplay,                  inline: true  },
        { name: '✉️ Message',  value: message.slice(0, 1024),         inline: false },
        { name: '🔗 View Villa', value: villaLink,                    inline: false },
        { name: '⏰ Timestamp', value: formatTimestamp(new Date()),   inline: false },
      ],
      footer: { text: 'The Villa Net • Inquiry System' },
      timestamp: new Date().toISOString(),
    }],
  };

  return sendToDiscord(DISCORD_WEBHOOK_INQUIRIES, embed);
}