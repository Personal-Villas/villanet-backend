import { pool } from '../db.js';
import { sendEmail } from '../services/email.service.js';
import { getAvailabilityFor, checkStrictAvailability } from '../services/availability.service.js';
import pLimit from "p-limit";

// noches de estadía: from..to-1
function countStayNights(from, to) {
    const start = new Date(from);
    const end = new Date(to);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    if (start >= end) return 0;
    const ms = end.getTime() - start.getTime();
    return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
  }
  
  function ymd10(s) {
    if (!s) return null;
    const str = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    const d = new Date(str);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  
  export async function quotesAvailabilityCheck(req, res) {
    try {
      const checkIn = ymd10(req.body?.checkIn);
      const checkOut = ymd10(req.body?.checkOut);
      const strict = Boolean(req.body?.strict); // opcional
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
  
      if (!checkIn || !checkOut) {
        return res.status(400).json({ ok: false, error: "checkIn/checkOut requeridos (YYYY-MM-DD)" });
      }
      if (new Date(checkIn) >= new Date(checkOut)) {
        return res.status(400).json({ ok: false, error: "checkOut debe ser posterior a checkIn" });
      }
      if (!items.length) {
        return res.status(400).json({ ok: false, error: "items[] requerido" });
      }
  
      const ids = [...new Set(items.map((x) => String(x?.id || x?.listingId || "").trim()).filter(Boolean))];
      if (!ids.length) {
        return res.status(400).json({ ok: false, error: "No hay listing IDs válidos" });
      }
  
      const nights = countStayNights(checkIn, checkOut);
  
      // 1) check rápido (batch, cache)
      const quick = await getAvailabilityFor(ids, checkIn, checkOut);
      // quick: [{ listing_id, available, nightlyFrom, daysCount, hasRestrictions }]
  
      // Convertimos a mapa para lookup
      const byId = new Map(quick.map((r) => [String(r.listing_id), r]));
  
      // 2) armar response base
      // available:
      // - true => ok
      // - false => no disponible
      // - null => unknown (no data / incompleto / fallo)
      const results = ids.map((id) => {
        const r = byId.get(String(id));
        if (!r) {
          return { listingId: id, available: null, reason: "no-result" };
        }
  
        // Heurística: si no tengo days suficientes, lo marco unknown (para no bloquear injustamente)
        // daysCount debería ser == nights (o >0) si vino bien la data
        if (!Number.isFinite(r.daysCount) || r.daysCount < nights) {
          return {
            listingId: id,
            available: null,
            reason: r.daysCount === 0 ? "no-calendar-data" : "partial-calendar-data",
            meta: { daysCount: r.daysCount ?? null, nights },
          };
        }
  
        return {
          listingId: id,
          available: Boolean(r.available),
          reason: r.available ? undefined : "unavailable",
          meta: {
            nightlyFrom: r.nightlyFrom ?? null,
            hasRestrictions: Boolean(r.hasRestrictions),
            daysCount: r.daysCount ?? null,
            nights,
          },
        };
      });
  
      // 3) opcional: strict CTA/CTD solo para los que quedaron true (o unknown si querés)
      if (strict) {
        const limit = pLimit(2);
        const strictIds = results.filter((x) => x.available === true).map((x) => x.listingId);
  
        const strictPairs = await Promise.all(
          strictIds.map((id) =>
            limit(async () => {
              try {
                const ok = await checkStrictAvailability(id, checkIn, checkOut);
                return [id, ok];
              } catch {
                return [id, null];
              }
            })
          )
        );
  
        const strictMap = new Map(strictPairs);
  
        for (const r of results) {
          if (r.available === true && strictMap.has(r.listingId)) {
            const ok = strictMap.get(r.listingId);
            if (ok === false) {
              r.available = false;
              r.reason = "restricted-cta-ctd";
            } else if (ok === null) {
              r.available = null;
              r.reason = "strict-check-failed";
            }
          }
        }
      }
  
      return res.json({ ok: true, results });
    } catch (e) {
      console.error("❌ /quotes/availability-check error:", e);
      return res.status(500).json({ ok: false, error: "Error interno", details: e.message });
    }
  }

// ================ HELPERS ================

/**
 * Convierte una fecha a formato YYYY-MM-DD (UTC)
 * @param {any} d - Fecha a convertir (Date, string, etc.)
 * @returns {string|null} Fecha en formato YYYY-MM-DD o null si no es válida
 */
function toYmd(d) {
  if (!d) return null;
  
  // si ya viene "YYYY-MM-DD"
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  
  // IMPORTANTE: usar UTC para evitar que te cambie el día por timezone
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Normaliza una URL o dominio de Guesty a base URL consistente
 * @param {string} domainOrUrl - Dominio o URL completa
 * @returns {string} URL base normalizada
 */
function normalizeBaseUrl(domainOrUrl) {
  if (!domainOrUrl || typeof domainOrUrl !== "string") return "https://book.guesty.com";
  
  const raw = domainOrUrl.trim().replace(/\/+$/, "");
  const withProto = raw.startsWith("http://") || raw.startsWith("https://") 
    ? raw 
    : `https://${raw}`;
  
  return withProto.replace(/\/+$/, "");
}

/**
 * Construye URL de Guesty con parámetros pre-llenados
 * ✅ VERSIÓN CORREGIDA para *.guestybookings.com y book.guesty.com
 * @param {Object} params
 * @param {string} params.domainOrUrl - Dominio o URL de Guesty
 * @param {string|number} params.listingId - ID de la propiedad
 * @param {string} [params.checkInYmd] - Check-in en formato YYYY-MM-DD
 * @param {string} [params.checkOutYmd] - Check-out en formato YYYY-MM-DD
 * @param {number} [params.guests] - Número de huéspedes (para minOccupancy)
 * @returns {string} URL completa de Guesty
 */
function buildGuestyUrl({ domainOrUrl, listingId, checkInYmd, checkOutYmd, guests }) {
  const base = normalizeBaseUrl(domainOrUrl);
  const url = new URL(base);

  const host = url.host;
  const id = encodeURIComponent(String(listingId));

  // ✅ 1) Portales custom: *.guestybookings.com
  if (host.endsWith("guestybookings.com")) {
    url.pathname = `/en/properties/${id}`;
  }
  // ✅ 2) book.guesty.com (siempre /villas/:id)
  else if (host === "book.guesty.com") {
    url.pathname = `/villas/${id}`;
  }
  // ✅ 3) fallback genérico
  else {
    url.pathname = `/villas/${id}`;
  }

  // ✅ minOccupancy: SIEMPRE enviar (default 1)
  const g = Number(guests);
  const occupancy = Number.isFinite(g) && g > 0 ? g : 1;
  url.searchParams.set("minOccupancy", String(occupancy));

  // ✅ Query params como en el ejemplo real (camelCase)
  if (checkInYmd) url.searchParams.set("checkIn", checkInYmd);
  if (checkOutYmd) url.searchParams.set("checkOut", checkOutYmd);

  return url.toString();
}

// ================ CONTROLLERS ================

/**
 * POST /quotes
 * Crea un nuevo quote con sus items
 */
export async function createQuote(req, res) {
  const client = await pool.connect();
  
  try {
    const { clientName, clientEmail, checkIn, checkOut, guests, items } = req.body;

    console.log('📥 CREATE QUOTE - Request body:', {
      clientName,
      clientEmail,
      checkIn,
      checkOut,
      guests,
      itemsCount: items?.length
    });

    // Validaciones básicas
    if (!clientEmail) {
      console.error('❌ clientEmail missing');
      return res.status(400).json({ error: "clientEmail es requerido" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      console.error('❌ items missing or empty');
      return res.status(400).json({ error: "Debe incluir al menos una propiedad en items" });
    }

    // 🔍 LOG: Verificar dominios que llegan
    console.log('🔍 INCOMING ITEMS - guestyBookingDomain check:');
    items.forEach((item, idx) => {
      console.log(`  [${idx}] listing_id: ${item.id}, guestyBookingDomain: "${item.guestyBookingDomain}"`);
      if (!item.guestyBookingDomain) {
        console.warn(`  ⚠️  Item ${item.id} NO tiene guestyBookingDomain!`);
      }
    });

    await client.query('BEGIN');

    // 1) Crear el quote principal
    const quoteQuery = await client.query(
      `INSERT INTO quotes (
        created_by_user_id, 
        client_name, 
        client_email, 
        check_in, 
        check_out, 
        guests, 
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'draft')
      RETURNING id, created_at`,
      [
        req.user.id, // viene del middleware auth
        clientName || null,
        clientEmail,
        checkIn || null,
        checkOut || null,
        guests || null
      ]
    );

    const quoteId = quoteQuery.rows[0].id;
    console.log(`✅ Quote creado con ID: ${quoteId}`);

    // 2) Insertar cada item del quote
    for (const item of items) {
      if (!item.id) {
        throw new Error(`Item sin ID: ${JSON.stringify(item)}`);
      }
      
      // Validar que tenga el dominio de Guesty
      if (!item.guestyBookingDomain) {
        console.error(`❌ CRITICAL: Falta guestyBookingDomain para listing ${item.id}`);
        throw new Error(`Falta guestyBookingDomain para la propiedad ${item.id}`);
      }

      console.log(`💾 Insertando item: ${item.id} con domain: ${item.guestyBookingDomain}`);

      await client.query(
        `INSERT INTO quote_items (
          quote_id, 
          listing_id, 
          listing_name, 
          listing_location, 
          bedrooms, 
          bathrooms, 
          price_usd, 
          image_url, 
          guesty_booking_domain
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (quote_id, listing_id) DO NOTHING`,
        [
          quoteId,
          item.id,
          item.name || null,
          item.location || null,
          item.bedrooms ?? null,
          item.bathrooms ?? null,
          item.priceUSD ? Number(item.priceUSD) : null,
          item.imageUrl || null,
          item.guestyBookingDomain  // ✅ Guardando el dominio correcto
        ]
      );
    }

    // 3) Registrar en el historial
    await client.query(
      `INSERT INTO quote_history (
        quote_id, 
        event_type, 
        actor_user_id, 
        payload
      ) VALUES ($1, 'CREATED', $2, $3)`,
      [
        quoteId,
        req.user.id,
        JSON.stringify({
          itemsCount: items.length,
          clientEmail,
          checkIn,
          checkOut
        })
      ]
    );

    await client.query('COMMIT');
    console.log(`✅ Transaction committed - Quote ${quoteId} con ${items.length} propiedades`);

    res.status(201).json({
      success: true,
      quoteId,
      message: `Quote creado con ${items.length} propiedades`
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error creando quote:', error);
    console.error('Stack trace:', error.stack);
    
    res.status(500).json({
      error: 'Error interno al crear el quote',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
}

/**
 * GET /quotes/:id
 * Obtiene los detalles de un quote
 */
export async function getQuoteDetails(req, res) {
  try {
    const { id } = req.params;

    console.log(`📖 GET QUOTE - ID: ${id}`);

    // 1) Obtener quote principal
    const quoteResult = await pool.query(
      `SELECT 
        q.*,
        u.email as created_by_email,
        u.full_name as created_by_name
       FROM quotes q
       LEFT JOIN users u ON q.created_by_user_id = u.id
       WHERE q.id = $1`,
      [id]
    );

    if (quoteResult.rows.length === 0) {
      console.error(`❌ Quote ${id} no encontrado`);
      return res.status(404).json({ error: 'Quote no encontrado' });
    }

    // 2) Obtener items del quote
    const itemsResult = await pool.query(
      `SELECT * FROM quote_items 
       WHERE quote_id = $1 
       ORDER BY created_at`,
      [id]
    );

    console.log(`✅ Quote ${id} encontrado con ${itemsResult.rows.length} items`);

    // 🔍 LOG: Verificar dominios guardados en DB
    console.log('🔍 ITEMS FROM DB - domain check:');
    itemsResult.rows.forEach((item, idx) => {
      console.log(`  [${idx}] listing_id: ${item.listing_id}, guesty_booking_domain: "${item.guesty_booking_domain}"`);
    });

    // 3) Obtener historial
    const historyResult = await pool.query(
      `SELECT * FROM quote_history 
       WHERE quote_id = $1 
       ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      quote: quoteResult.rows[0],
      items: itemsResult.rows,
      history: historyResult.rows
    });

  } catch (error) {
    console.error('❌ Error obteniendo quote:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Error interno' });
  }
}

/**
 * POST /quotes/:id/send
 * Envía el email con los links de Guesty
 * ✅ VERSIÓN CORREGIDA con builder nuevo y logs de debug
 */
export async function sendQuoteEmail(req, res) {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const userId = req.user.id;

    console.log(`📧 SEND QUOTE EMAIL - Quote ID: ${id}, User ID: ${userId}`);

    await client.query("BEGIN");

    // 1) Verificar que el quote existe y está en draft (con FOR UPDATE)
    const quoteResult = await client.query(
      `SELECT * FROM quotes 
       WHERE id = $1 AND status = 'draft'
       FOR UPDATE`,
      [id]
    );

    if (quoteResult.rows.length === 0) {
      await client.query("ROLLBACK");
      console.error(`❌ Quote ${id} no encontrado o ya enviado`);
      return res.status(404).json({ 
        error: "Quote no encontrado o ya fue enviado" 
      });
    }

    const quote = quoteResult.rows[0];
    console.log(`✅ Quote encontrado:`, {
      id: quote.id,
      client_email: quote.client_email,
      check_in: quote.check_in,
      check_out: quote.check_out,
      guests: quote.guests
    });

    // 2) Obtener items para el email
    const itemsResult = await client.query(
      `SELECT * FROM quote_items WHERE quote_id = $1`,
      [id]
    );

    const items = itemsResult.rows;
    if (items.length === 0) {
      await client.query("ROLLBACK");
      console.error(`❌ Quote ${id} sin items`);
      return res.status(400).json({ 
        error: "El quote no tiene propiedades" 
      });
    }

    // 🔥 LOG CRÍTICO: Verificar dominios que vienen de la DB
    console.log('🔥 DOMAINS IN DB:', items.map(i => ({
      listing_id: i.listing_id,
      listing_name: i.listing_name,
      guesty_booking_domain: i.guesty_booking_domain
    })));

    // 3) Convertir fechas a formato YYYY-MM-DD para Guesty
    const checkInYmd = toYmd(quote.check_in);
    const checkOutYmd = toYmd(quote.check_out);

    console.log(`📅 Fechas convertidas: checkIn=${checkInYmd}, checkOut=${checkOutYmd}`);

    // 4) Generar URLs de Guesty usando el builder corregido
    const itemsWithUrls = items.map((item, idx) => {
      console.log(`\n🔗 Building URL for item ${idx}:`);
      console.log(`  listing_id: ${item.listing_id}`);
      console.log(`  domain from DB: ${item.guesty_booking_domain}`);
      console.log(`  guests: ${quote.guests} (will default to 1 if invalid)`);

      const guestyUrl = buildGuestyUrl({
        domainOrUrl: item.guesty_booking_domain || "https://book.guesty.com",
        listingId: item.listing_id,
        checkInYmd,
        checkOutYmd,
        guests: quote.guests,
      });

      console.log(`  ✅ Generated URL: ${guestyUrl}`);

      return { ...item, guestyUrl };
    });

    // 🔍 LOG: URLs finales generadas
    console.log('\n📋 FINAL URLs GENERATED:');
    itemsWithUrls.forEach((item, idx) => {
      console.log(`  [${idx}] ${item.listing_name}`);
      console.log(`       ${item.guestyUrl}`);
    });

    // 5) Generar HTML del email
    const emailHtml = generateQuoteEmailHtml(quote, itemsWithUrls);

    // 6) Enviar email
    console.log(`📮 Enviando email a: ${quote.client_email}`);
    await sendEmail({
      to: quote.client_email,
      subject: `Villa Quote for - ${quote.client_name || "Guest"}`,
      html: emailHtml,
      attachments: [],
    });
    console.log(`✅ Email enviado exitosamente`);

    // 7) Actualizar estado del quote
    await client.query(
      `UPDATE quotes SET status = 'sent', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // 8) Registrar en historial
    await client.query(
      `INSERT INTO quote_history (quote_id, event_type, actor_user_id, payload)
       VALUES ($1, 'EMAIL_SENT', $2, $3)`,
      [
        id,
        userId,
        JSON.stringify({
          to: quote.client_email,
          itemsCount: items.length,
          checkIn: checkInYmd,
          checkOut: checkOutYmd,
          timestamp: new Date().toISOString(),
        }),
      ]
    );

    await client.query("COMMIT");
    console.log(`✅ Transaction committed - Email sent for quote ${id}`);

    return res.json({
      success: true,
      message: `Email enviado a ${quote.client_email}`,
      itemsSent: items.length,
      quoteId: id,
      debugExampleUrl: itemsWithUrls[0]?.guestyUrl,
      debugAllUrls: itemsWithUrls.map(i => ({
        listing_id: i.listing_id,
        name: i.listing_name,
        url: i.guestyUrl
      }))
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error enviando email de quote:", error);
    console.error("Stack trace:", error.stack);
    
    return res.status(500).json({
      error: "Error interno al enviar el email",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
}

/**
 * Genera el HTML del email
 */
function generateQuoteEmailHtml(quote, items) {
    const formatDate = (dateStr) => {
      if (!dateStr) return 'Flexible';
      return new Date(dateStr).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    };
  
    const formatCurrency = (amount) => {
      if (!amount) return 'Contact for pricing';
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(amount);
    };
  
    return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        line-height: 1.6; 
        color: #09090b;
        background: #f9fafb;
      }
      .container { 
        max-width: 600px; 
        margin: 0 auto; 
        background: #ffffff;
      }
      .header { 
        background: #ffffff;
        padding: 48px 32px 32px;
        text-align: center;
        border-bottom: 1px solid #e5e5e5;
      }
      .header-label {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.125em;
        text-transform: uppercase;
        color: #71717a;
        margin-bottom: 16px;
      }
      .header h1 { 
        font-size: 32px;
        font-weight: 600;
        line-height: 1.1;
        color: #09090b;
        margin-bottom: 12px;
      }
      .header p {
        font-size: 16px;
        color: #71717a;
        line-height: 1.6;
      }
      .content { 
        padding: 32px;
        background: #ffffff;
      }
      .date-info {
        background: #f4f4f5;
        padding: 20px;
        border-radius: 8px;
        margin-bottom: 32px;
        border-left: 3px solid #09090b;
      }
      .date-info p {
        font-size: 14px;
        color: #09090b;
        margin: 4px 0;
      }
      .date-info strong {
        font-weight: 600;
      }
      .property-card { 
        background: #ffffff;
        margin: 24px 0;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        overflow: hidden;
        transition: box-shadow 0.2s;
      }
      .property-image { 
        width: 100%; 
        height: 240px; 
        object-fit: cover;
        display: block;
      }
      .property-content {
        padding: 24px;
      }
      .property-content h3 {
        font-size: 20px;
        font-weight: 600;
        color: #09090b;
        margin-bottom: 16px;
        line-height: 1.2;
      }
      .property-details {
        margin: 16px 0;
      }
      .property-detail {
        font-size: 14px;
        color: #52525b;
        margin: 8px 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .property-detail strong {
        color: #09090b;
        font-weight: 500;
      }
      .price-tag {
        background: #f4f4f5;
        padding: 16px;
        border-radius: 6px;
        margin: 20px 0;
        text-align: center;
      }
      .price-tag .label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #71717a;
        margin-bottom: 4px;
      }
      .price-tag .amount {
        font-size: 24px;
        font-weight: 600;
        color: #09090b;
      }
      .btn { 
        display: inline-block;
        width: 100%;
        background: #09090b;
        color: #ffffff;
        padding: 14px 24px;
        text-decoration: none;
        border-radius: 6px;
        font-weight: 500;
        font-size: 15px;
        text-align: center;
        transition: background 0.2s;
      }
      .btn-note {
        font-size: 12px;
        color: #71717a;
        font-style: italic;
        margin-top: 12px;
        text-align: center;
      }
      .divider {
        height: 1px;
        background: #e5e5e5;
        margin: 32px 0;
      }
      .tip-box {
        background: #fafafa;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        margin: 32px 0;
      }
      .tip-box p {
        font-size: 14px;
        color: #52525b;
        line-height: 1.5;
      }
      .tip-box strong {
        color: #09090b;
        font-weight: 600;
      }
      .footer { 
        background: #fafafa;
        padding: 32px;
        text-align: center;
        border-top: 1px solid #e5e5e5;
      }
      .footer p {
        font-size: 13px;
        color: #71717a;
        margin: 8px 0;
        line-height: 1.5;
      }
      .footer-meta {
        font-size: 11px;
        color: #a1a1aa;
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid #e5e5e5;
      }
      @media only screen and (max-width: 600px) {
        .header { padding: 32px 20px 24px; }
        .content { padding: 20px; }
        .header h1 { font-size: 26px; }
        .property-content { padding: 20px; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="header-label">VILLA SELECTION</div>
        <h1>Luxury Villas for Your Trip</h1>
        <p>Hello ${quote.client_name || 'Valued Guest'},</p>
        <p>We've selected these exceptional properties based on your preferences.</p>

      </div>
      
      <div class="content">
        <div class="date-info">
          <p><strong>📅 Check-in:</strong> ${formatDate(quote.check_in)}</p>
          <p><strong>📅 Check-out:</strong> ${formatDate(quote.check_out)}</p>
          ${quote.guests ? `<p><strong>👥 Guests:</strong> ${quote.guests}</p>` : ''}
        </div>
  
        ${items.map(item => `
          <div class="property-card">
            ${item.image_url ? `<img src="${item.image_url}" class="property-image" alt="${item.listing_name}">` : ''}
            <div class="property-content">
              <h3>${item.listing_name || 'Luxury Villa'}</h3>
              
              <div class="property-details">
                <div class="property-detail">
                  <strong>📍 Location:</strong> ${item.listing_location || 'Contact for details'}
                </div>
                <div class="property-detail">
                  <strong>🛏️ Bedrooms:</strong> ${item.bedrooms || 'N/A'}
                </div>
                <div class="property-detail">
                  <strong>🛁 Bathrooms:</strong> ${item.bathrooms || 'N/A'}
                </div>
              </div>
  
              <div class="price-tag">
                <div class="label">Price per Night</div>
                <div class="amount">${formatCurrency(item.price_usd)}</div>
              </div>
  
              <a href="${item.guestyUrl}" class="btn">View Availability & Book →</a>
              <p class="btn-note">Your selected dates are pre-filled</p>
            </div>
          </div>
        `).join('')}
  
        <div class="divider"></div>
  
        <div class="tip-box">
          <p><strong>💡 Next Steps:</strong> Click the button on each villa to check real-time availability and finalize pricing for your dates.</p>
        </div>
  
        <div class="footer">
          <p><strong>Book with Confidence. Earn with Trust.</strong></p>
          <p>This quote was generated by Villa Net — connecting you with the world's most vetted villas.</p>
          <p>Questions? Contact your travel advisor.</p>
          <div class="footer-meta">
            Quote ID: ${quote.id} • Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>
    </div>
  </body>
  </html>
    `;
  }

export async function checkQuotesAvailability(req, res) {
    try {
      const { checkIn, checkOut, guests, items } = req.body || {};
  
      if (!checkIn || !checkOut) {
        return res.status(400).json({ ok: false, error: 'checkIn y checkOut son requeridos' });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ ok: false, error: 'items es requerido (array)' });
      }
  
      const results = await checkGuestyAvailabilityBatch({
        checkIn,
        checkOut,
        guests: guests || null,
        items: items.map((it) => ({
          id: String(it.id),
          guestyBookingDomain: it.guestyBookingDomain || null,
        })),
      });
  
      return res.json({ ok: true, results });
    } catch (e) {
      console.error('❌ availability-check error:', e);
      return res.status(500).json({ ok: false, error: 'Error interno', details: e.message });
    }
  }
  