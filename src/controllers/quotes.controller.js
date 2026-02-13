import { pool } from "../db.js";
import { sendEmail } from "../services/email.service.js";
import {
  getAvailabilityFor,
  checkStrictAvailability,
} from "../services/availability.service.js";
import pLimit from "p-limit";
import { guesty } from "../services/guestyClient.js";
import crypto from "crypto";
import {
  sendQuoteNotification,
  notifySafely,
} from "../services/discordNotification.service.js";

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
      return res
        .status(400)
        .json({ ok: false, error: "checkIn/checkOut requeridos (YYYY-MM-DD)" });
    }
    if (new Date(checkIn) >= new Date(checkOut)) {
      return res
        .status(400)
        .json({ ok: false, error: "checkOut debe ser posterior a checkIn" });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "items[] requerido" });
    }

    const ids = [
      ...new Set(
        items
          .map((x) => String(x?.id || x?.listingId || "").trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No hay listing IDs válidos" });
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
          reason:
            r.daysCount === 0 ? "no-calendar-data" : "partial-calendar-data",
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
      const strictIds = results
        .filter((x) => x.available === true)
        .map((x) => x.listingId);

      const strictPairs = await Promise.all(
        strictIds.map((id) =>
          limit(async () => {
            try {
              const ok = await checkStrictAvailability(id, checkIn, checkOut);
              return [id, ok];
            } catch {
              return [id, null];
            }
          }),
        ),
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
    return res
      .status(500)
      .json({ ok: false, error: "Error interno", details: e.message });
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
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;

  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;

  return dt.toISOString().split("T")[0];
}

/**
 * Normaliza una URL o dominio de Guesty a base URL consistente
 * @param {string} domainOrUrl - Dominio o URL completa
 * @returns {string} URL base normalizada
 */
function normalizeBaseUrl(domainOrUrl) {
  if (!domainOrUrl || typeof domainOrUrl !== "string")
    return "https://book.guesty.com";

  const raw = domainOrUrl.trim().replace(/\/+$/, "");
  const withProto =
    raw.startsWith("http://") || raw.startsWith("https://")
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
function buildGuestyUrl({
  domainOrUrl,
  listingId,
  checkInYmd,
  checkOutYmd,
  guests,
}) {
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
    const { clientName, clientEmail, checkIn, checkOut, guests, items } =
      req.body;

    console.log("📥 CREATE QUOTE - Request body:", {
      clientName,
      clientEmail,
      checkIn,
      checkOut,
      guests,
      itemsCount: items?.length,
    });

    // Validaciones básicas
    if (!clientEmail) {
      console.error("❌ clientEmail missing");
      return res.status(400).json({ error: "clientEmail es requerido" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      console.error("❌ items missing or empty");
      return res
        .status(400)
        .json({ error: "Debe incluir al menos una propiedad en items" });
    }

    // 🔍 LOG: Verificar dominios que llegan
    console.log("🔍 INCOMING ITEMS - guestyBookingDomain check:");
    items.forEach((item, idx) => {
      console.log(
        `  [${idx}] listing_id: ${item.id}, guestyBookingDomain: "${item.guestyBookingDomain}"`,
      );
      if (!item.guestyBookingDomain) {
        console.warn(`  ⚠️  Item ${item.id} NO tiene guestyBookingDomain!`);
      }
    });

    await client.query("BEGIN");

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
        guests || null,
      ],
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
        console.error(
          `❌ CRITICAL: Falta guestyBookingDomain para listing ${item.id}`,
        );
        throw new Error(
          `Falta guestyBookingDomain para la propiedad ${item.id}`,
        );
      }

      console.log(
        `💾 Insertando item: ${item.id} con domain: ${item.guestyBookingDomain}`,
      );

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
          item.guestyBookingDomain, // ✅ Guardando el dominio correcto
        ],
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
          checkOut,
        }),
      ],
    );

    await client.query("COMMIT");
    console.log(
      `✅ Transaction committed - Quote ${quoteId} con ${items.length} propiedades`,
    );

    res.status(201).json({
      success: true,
      quoteId,
      message: `Quote creado con ${items.length} propiedades`,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error creando quote:", error);
    console.error("Stack trace:", error.stack);

    res.status(500).json({
      error: "Error interno al crear el quote",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
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
      [id],
    );

    if (quoteResult.rows.length === 0) {
      console.error(`❌ Quote ${id} no encontrado`);
      return res.status(404).json({ error: "Quote no encontrado" });
    }

    // 2) Obtener items del quote
    const itemsResult = await pool.query(
      `SELECT * FROM quote_items 
       WHERE quote_id = $1 
       ORDER BY created_at`,
      [id],
    );

    console.log(
      `✅ Quote ${id} encontrado con ${itemsResult.rows.length} items`,
    );

    // 🔍 LOG: Verificar dominios guardados en DB
    console.log("🔍 ITEMS FROM DB - domain check:");
    itemsResult.rows.forEach((item, idx) => {
      console.log(
        `  [${idx}] listing_id: ${item.listing_id}, guesty_booking_domain: "${item.guesty_booking_domain}"`,
      );
    });

    // 3) Obtener historial
    const historyResult = await pool.query(
      `SELECT * FROM quote_history 
       WHERE quote_id = $1 
       ORDER BY created_at DESC`,
      [id],
    );

    res.json({
      quote: quoteResult.rows[0],
      items: itemsResult.rows,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error("❌ Error obteniendo quote:", error);
    console.error("Stack trace:", error.stack);
    res.status(500).json({ error: "Error interno" });
  }
}
/**
 * POST /quotes/:id/send
 * Envía el email. Maneja fechas nulas (Flexibles) y define 'items' correctamente.
 */
export async function sendQuoteEmail(req, res) {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const userId = req.user.id; // Puede ser undefined si no hay auth middleware estricto, no es crítico para el envío

    console.log(`📧 SEND QUOTE EMAIL - Quote ID: ${id}`);

    await client.query("BEGIN");

    // 1) Obtener el quote
    const quoteResult = await client.query(
      `SELECT * FROM quotes WHERE id = $1 AND status = 'draft' FOR UPDATE`,
      [id],
    );

    if (quoteResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "Quote no encontrado o ya enviado" });
    }

    const quote = quoteResult.rows[0];

    // 🔥 DEBUG: Verificamos qué viene exactamente de la BD
    console.log("🔍 DATOS CRUDOS DB:", {
      id: quote.id,
      check_in_db: quote.check_in,
      check_out_db: quote.check_out,
      client_email: quote.client_email,
    });

    // 2) Obtener items (villas)
    const itemsResult = await client.query(
      `SELECT qi.*, COALESCE(l.villanet_commission_rate, 0) as commission_rate 
       FROM quote_items qi
       LEFT JOIN listings l ON qi.listing_id = l.listing_id
       WHERE qi.quote_id = $1`,
      [id],
    );

    const items = itemsResult.rows;

    if (items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El quote no tiene propiedades" });
    }

    // --- PREPARACIÓN DE DATOS ---
    const checkInYmd = toYmd(quote.check_in);
    const checkOutYmd = toYmd(quote.check_out);

    // Detectar si hay fechas válidas
    const hasDates = checkInYmd && checkOutYmd;

    // Si hay fechas, calculamos noches. Si no, ponemos 1 para efectos visuales de precio base.
    const nights = hasDates ? countStayNights(checkInYmd, checkOutYmd) : 1;

    console.log(
      `📅 Datos: CheckIn=${checkInYmd}, CheckOut=${checkOutYmd}, Nights=${nights}, HasDates=${hasDates}`,
    );

    // 3) Procesamiento Paralelo
    const itemsWithFullData = await Promise.all(
      items.map(async (item) => {
        let breakdown = null;

        // Solo llamamos a Guesty si tenemos fechas. Si es flexible, saltamos este paso.
        if (hasDates) {
          breakdown = await getGuestyBreakdown(
            item.listing_id,
            checkInYmd,
            checkOutYmd,
            quote.guests,
            item.commission_rate,
          );
        }

        // Generar URL (Guesty maneja URLs sin fechas, solo lleva al listing)
        const guestyUrl = buildGuestyUrl({
          domainOrUrl: item.guesty_booking_domain || "https://book.guesty.com",
          listingId: item.listing_id,
          checkInYmd,
          checkOutYmd,
          guests: quote.guests,
        });

        // Fallback: Si no hay breakdown (por fechas nulas o error api), calculamos el base localmente
        const finalBreakdown = breakdown || {
          base: Number(item.price_usd) * nights,
          taxes: 0,
          cleaning: 0,
          commission_rate: 0,
          totalGross: Number(item.price_usd) * nights,
          currency: "USD",
          isEstimate: true, // Marca para el frontend/email
        };

        return {
          ...item,
          guestyUrl,
          breakdown: finalBreakdown,
        };
      }),
    );

    // 4) Generar HTML
    // Pasamos 'nights' explícitamente para que el template no falle
    const emailHtml = await generateQuoteEmailHtml(
      quote,
      itemsWithFullData,
      nights,
      checkInYmd,
      checkOutYmd,
    );

    // 5) Enviar email
    console.log(`📮 Enviando email a: ${quote.client_email}`);
    await sendEmail({
      to: quote.client_email,
      subject: `Your Curated Villa Options from - ${quote.client_name || "Guest"}`,
      html: emailHtml,
    });

    // 6) Actualizar DB
    await client.query(
      `UPDATE quotes SET status = 'sent', updated_at = NOW() WHERE id = $1`,
      [id],
    );

    // 7) Notificar Discord (Calculando el total con los datos procesados)
    const totalQuoteAmount = itemsWithFullData.reduce(
      (sum, i) => sum + (i.breakdown?.totalGross || 0),
      0,
    );

    notifySafely(() =>
      sendQuoteNotification({
        quoteId: id,
        clientEmail: quote.client_email,
        clientName: quote.client_name,
        villas: itemsWithFullData.map((i) => ({
          name: i.listing_name,
          price: i.breakdown.totalGross,
        })),
        checkIn: checkInYmd,
        checkOut: checkOutYmd,
        guests: quote.guests,
        totalPrice: totalQuoteAmount,
        downloadUrl: itemsWithFullData[0]?.guestyUrl,
      }),
    );

    await client.query("COMMIT");
    console.log(`✅ Email enviado correctamente para Quote ${id}`);

    return res.json({
      success: true,
      message: `Email enviado a ${quote.client_email}`,
      quoteId: id,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error enviando email de quote:", error);
    // IMPORTANTE: Devolver json para que el frontend no se cuelgue
    return res.status(500).json({
      error: "Error interno al enviar el email",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
}

/**
 * Genera el HTML del email
 */
export async function generateQuoteEmailHtml(
  quote,
  items,
  nights,
  checkInYmd,
  checkOutYmd,
) {
  const formatDate = (dateStr) => {
    if (!dateStr) return "Flexible Dates";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  };

  const formatCurrency = (amount) => {
    if (!amount) return "Contact for pricing";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount || 0);
  };

  const safeNights = nights || 1;

  const mapPin = `<img src="https://cdn-icons-png.flaticon.com/128/484/484167.png" width="14" height="14" style="vertical-align:middle; margin-right:4px; opacity:0.6;" alt="Location">`;
  const guestIcon = `<img src="https://cdn-icons-png.flaticon.com/128/1077/1077063.png" width="14" height="14" style="vertical-align:middle; margin-right:4px; opacity:0.6;" alt="Guests">`;
  const calendarIcon = `<img src="https://cdn-icons-png.flaticon.com/128/2838/2838779.png" width="14" height="14" style="vertical-align:middle; margin-right:4px; opacity:0.6;" alt="Calendar">`;
  const nightsIcon = `<img src="https://cdn-icons-png.flaticon.com/128/606/606807.png" width="14" height="14" style="vertical-align:middle; margin-right:4px; opacity:0.6;" alt="Nights">`;
  
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { 
        font-family: Inter;
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
      .breakdown-container{
        background:#f9fafb;
        padding:15px;
         border-radius:8px;
      }
      .breakdown-row { 
        margin-bottom: 12px; 
        font-size: 14px; 
      }
      .breakdown-label { 
        display: block; 
        color: #666; 
        margin-bottom: 2px;
      }
      .breakdown-value { 
        display: block; 
        font-weight: bold; 
        font-size: 15px;
      }
      
      .btn { 
        display: inline-block;
        width: 100%;
        background: #000;
        color: #ffffff !important;
        padding: 14px 24px;
        text-decoration: none;
        border-radius: 6px;
        font-weight: bold;
        font-size: 13px;
        text-align: center;
        transition: background 0.2s;
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

      .villanet-badge {
        display: inline-block;
        color: #111111;           
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.5px;
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
        <div>
          <span class="villanet-badge">villanet</span>
        </div>
        <h1>Your Curated Villa Options</h1>
        <p>Hello ${quote.client_name || "Valued Guest"}!</p>
        <p>Based on your preferences, here is a selection of properties for your review</p>

      </div>
      
      <div class="content">
        <div class="date-info">
          <p><strong>${calendarIcon} Check-in:</strong> ${formatDate(checkInYmd)}</p>
          <p><strong>${calendarIcon} Check-out:</strong> ${formatDate(checkOutYmd)}</p>
          <p><strong>${nightsIcon} Nights:</strong> ${safeNights}</p>
          ${quote.guests ? `<p><strong>${guestIcon} Guests:</strong> ${quote.guests || 1}</p>` : ""}
        </div>
  
        ${items
          .map((item) => {
            const b = item.breakdown;
            if (!b) return ""; // O manejar error de villa no disponible

            return `
          <div class="property-card">
            ${item.image_url ? `<img src="${item.image_url}" class="property-image">` : ""}
            <div class="property-content">
              <h3>${item.listing_name || "Luxury Villa"}</h3>
              <p style="font-size:14px; color:#71717a; margin-bottom:12px;">${mapPin} ${item.listing_location || "Contact for details"}</p>
  
              <div class="breakdown-container">
                <div class="breakdown-row">
                  <div class="breakdown-label">
                    Base Rate (${safeNights} nights)
                  </div>
                  <span class="breakdown-value">${formatCurrency(b.base, b.currency)}</span>
                </div>
                
                ${
                  b.cleaning > 0
                    ? `
                <div class="breakdown-row">
                  <div class="breakdown-label">
                    Cleaning Fee
                  </div>
                  <span class="breakdown-value">${formatCurrency(b.cleaning, b.currency)}</span>
                </div>`
                    : ""
                }

                ${
                  b.taxes > 0
                    ? `
                <div class="breakdown-row">
                  <div class="breakdown-label">
                    Taxes & Fees
                  </div>
                  <span class="breakdown-value">${formatCurrency(b.taxes, b.currency)}</span>
                </div>`
                    : ""
                }

                ${
                  b.commission_rate > 0
                    ? `
                <div class="breakdown-row" style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:5px; color:#16a34a;">
                  <div class="breakdown-label">
                    Service Fee
                  </div>
                  <span class="breakdown-value">${formatCurrency(b.commission_rate, b.currency)}</span>
                </div>`
                    : ""
                }

               <div class="breakdown-row">
                  <div class="breakdown-label">
                     Total Quote
                  </div>
                  <span class="breakdown-value">${formatCurrency(b.totalGross, b.currency)}</span>
                </div>
              </div>
  
              <div style="margin-top:20px;">
                <a href="${item.guestyUrl}" class="btn">View Availability & Book →</a>
              </div>
            </div>
          </div>
        `;
          })
          .join("")}
        
        <div class="footer">
          <p>These properties are professionally managed and vetted for service standards and accuracy.</p>
          <p>Questions? Contact your travel advisor directly.</p>
        </div>
        <div style="display:none; white-space:nowrap; font:15px courier; line-height:0;">
          ${crypto.randomBytes(8).toString('hex')}
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
      return res
        .status(400)
        .json({ ok: false, error: "checkIn y checkOut son requeridos" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "items es requerido (array)" });
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
    console.error("❌ availability-check error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno", details: e.message });
  }
}

// --- helpers ---
function clampPct(x, min = 0, max = 100) {
  const n = Number(x);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ✅ NUEVO: Helper para redondeo a 2 decimales
function money2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function sumByPred(items, pred) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    if (!it) continue;
    if (!pred(it)) continue;

    const amt =
      Number(it.amount) ??
      Number(it.total) ??
      Number(it.value) ??
      Number(it.price) ??
      Number(it.netAmount) ??
      Number(it.grossAmount) ??
      Number(it.gross);

    if (Number.isFinite(amt)) total += amt;
  }
  return total;
}

/**
 * Parser definitivo - ajustado a la estructura REAL de tu response
 */
function parseGuestyQuote(raw) {
  const q = raw?.data ?? raw ?? {};

  // Búsqueda exhaustiva de invoiceItems - CORREGIDA con doble money
  let invoiceItems = [];
  invoiceItems =
    q?.rates?.ratePlans?.[0]?.money?.money?.invoiceItems ||
    q?.rates?.ratePlans?.[0]?.money?.invoiceItems ||
    q?.rates?.ratePlans?.[0]?.invoiceItems ||
    q?.money?.invoiceItems ||
    q?.invoiceItems ||
    q?.price?.invoiceItems ||
    q?.priceBreakdown?.invoiceItems ||
    [];

  // Debug si no encuentra
  if (invoiceItems.length === 0) {
    console.log(
      "[parseGuestyQuote] NO ENCONTRÓ invoiceItems. Rutas chequeadas:",
      {
        doubleMoney: !!q?.rates?.ratePlans?.[0]?.money?.money?.invoiceItems,
        ratePlansMoney: !!q?.rates?.ratePlans?.[0]?.money?.invoiceItems,
        ratePlans: !!q?.rates?.ratePlans?.[0]?.invoiceItems,
        money: !!q?.money?.invoiceItems,
        root: !!q?.invoiceItems,
        fullKeys: Object.keys(q),
      },
    );
  }

  // Base: accommodation fare / AF
  const base = sumByPred(invoiceItems, (it) => {
    const t = String(it.type || it.normalType || it.title || "").toLowerCase();
    return (
      t.includes("accommodation") ||
      t.includes("fare") ||
      it.normalType === "AF" ||
      it.title?.toLowerCase().includes("accommodation fare")
    );
  });

  // Cleaning
  const cleaning = sumByPred(invoiceItems, (it) => {
    const t = String(it.type || it.normalType || it.title || "").toLowerCase();
    return t.includes("clean") || t.includes("cleaning");
  });

  // Taxes (incluye isTax y tipos con "tax")
  const taxes = sumByPred(invoiceItems, (it) => {
    const t = String(it.type || it.normalType || it.title || "").toLowerCase();
    return (
      t.includes("tax") ||
      it.isTax === true ||
      it.normalType === "LT" ||
      it.normalType === "TAX"
    );
  });

  // Otros fees
  const otherFees = sumByPred(invoiceItems, (it) => {
    const t = String(it.type || it.normalType || it.title || "").toLowerCase();
    const isFee =
      t.includes("fee") || t.includes("service") || t.includes("resort");
    return isFee && !t.includes("clean") && !t.includes("tax");
  });

  const currency =
    invoiceItems[0]?.currency ||
    q?.rates?.ratePlans?.[0]?.days?.[0]?.currency ||
    q?.money?.currency ||
    q?.currency ||
    "USD";

  // Log detallado con cada item
  console.log("[parseGuestyQuote] Detected:", {
    invoiceItemsCount: invoiceItems.length,
    base,
    cleaning,
    taxes,
    otherFees,
    currency,
    itemsFound: invoiceItems.map((it) => ({
      title: it.title || it.name || "sin título",
      amount: it.amount,
      type: it.type || it.normalType || "sin tipo",
      isTax: it.isTax,
      normalType: it.normalType,
    })),
  });

  return { currency, base, cleaning, taxes, otherFees, invoiceItems };
}

// helper sin truncado
function safeJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

// --- controller ---
export async function calculateQuote(req, res) {
  const requestId = `qcalc_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  try {
    const listingId = String(req.body?.listingId || "").trim();
    const checkIn = String(req.body?.checkIn || "").trim();
    const checkOut = String(req.body?.checkOut || "").trim();

    const guestsCountRaw = Number(
      req.body?.guests ?? req.body?.guestsCount ?? 1,
    );
    const guestsCount = Number.isFinite(guestsCountRaw)
      ? Math.max(1, Math.floor(guestsCountRaw))
      : 1;

    // ✅ AJUSTE: Asegurar que commissionPct sea número válido
    const commissionPct = clampPct(req.body?.commissionPct ?? 0);

    console.log(`🧾 [${requestId}] /quotes/calculate incoming`, {
      listingId,
      checkIn,
      checkOut,
      guestsCount,
      commissionPct,
      userId: req.user?.id,
    });

    if (!listingId)
      return res.status(400).json({ ok: false, error: "listingId requerido" });
    if (!isYmd(checkIn) || !isYmd(checkOut))
      return res
        .status(400)
        .json({ ok: false, error: "checkIn/checkOut deben ser YYYY-MM-DD" });
    if (new Date(checkIn) >= new Date(checkOut))
      return res
        .status(400)
        .json({ ok: false, error: "checkOut debe ser posterior a checkIn" });

    const nights = countStayNights(checkIn, checkOut);
    if (nights <= 0)
      return res.status(400).json({ ok: false, error: "Rango inválido" });

    let cacheKey = null;
    try {
      cacheKey = crypto
        .createHash("sha1")
        .update(JSON.stringify({ listingId, checkIn, checkOut, guestsCount }))
        .digest("hex");
      console.log(`🧠 [${requestId}] cacheKey`, cacheKey);
    } catch (e) {
      console.warn(`⚠️ [${requestId}] cacheKey error`, e?.message);
    }

    const payload = {
      listingId,
      checkInDateLocalized: checkIn,
      checkOutDateLocalized: checkOut,
      guestsCount,
      source: "villanet_calculator",
      ignoreCalendar: false,
      ignoreTerms: false,
      ignoreBlocks: false,
    };

    // 🚨 AQUÍ VA EL LOG QUE PIDES - justo antes del POST
    console.log("🚨 payload -> Guesty", payload, {
      guestsCountType: typeof payload.guestsCount,
      guestsCountValue: payload.guestsCount,
      isInt: Number.isInteger(payload.guestsCount),
    });

    console.log(
      `➡️ [${requestId}] Guesty Open API POST /v1/quotes payload`,
      payload,
    );

    let guestyResp;
    try {
      guestyResp = await guesty.post("/v1/quotes", payload);
    } catch (e) {
      const status = e?.response?.status;
      console.error(`❌ [${requestId}] Guesty call failed`, {
        status,
        message: e?.message,
        data: safeJson(e?.response?.data),
      });

      if (status === 400 || status === 422) {
        const payload2 = { ...payload };
        delete payload2.guestsCount;
        payload2.guests = guestsCount;
        console.log(`🔁 [${requestId}] Retry with guests`, payload2);
        try {
          guestyResp = await guesty.post("/v1/quotes", payload2);
        } catch (e2) {
          console.error(`❌ Retry failed`, {
            data: safeJson(e2?.response?.data),
          });
          throw e2;
        }
      } else {
        throw e;
      }
    }

    console.log(`✅ [${requestId}] Guesty response`, {
      status: guestyResp?.status,
      topKeys: guestyResp?.data ? Object.keys(guestyResp.data) : [],
      dataPreview: safeJson(guestyResp?.data),
    });

    const parsed = parseGuestyQuote(guestyResp?.data);

    console.log(`🧩 [${requestId}] Parsed breakdown`, parsed);

    const baseSubtotal = Number(parsed.base) || 0;
    const cleaningFee = Number(parsed.cleaning) || 0;
    const taxesTotal = Number(parsed.taxes) || 0;

    const subtotal = baseSubtotal + cleaningFee + taxesTotal;
    const commission = subtotal * (commissionPct / 100);
    const totalGross = subtotal + commission;

    // ✅ AJUSTE: Aplicar redondeo money2 a todos los valores monetarios
    const response = {
      ok: true,
      currency: parsed.currency,
      nights,
      breakdown: {
        base: money2(baseSubtotal),
        cleaning: money2(cleaningFee),
        taxes: money2(taxesTotal),
        commissionPct,
        commission: money2(commission),
        totalGross: money2(totalGross),
        otherFees: money2(parsed.otherFees || 0),
      },
      source: "guesty_quote",
      ...(process.env.NODE_ENV === "development"
        ? {
            debug: {
              requestId,
              payloadSent: payload,
              cacheKey,
              invoiceItemsCount: parsed.invoiceItems?.length ?? 0,
              guestyStatus: guestyResp?.status,
            },
          }
        : {}),
    };

    console.log(`✅ [${requestId}] /quotes/calculate response`, response);
    return res.json(response);
  } catch (e) {
    console.error(`🔥 [${requestId}] error FULL`, {
      message: e?.message,
      status: e?.response?.status,
      data: safeJson(e?.response?.data),
      stack: e?.stack,
    });
    return res.status(502).json({
      ok: false,
      error: "guesty_quote_failed",
      message:
        "Failed to connect to Guesty. Please check your connection and retry",
      requestId,
      ...(process.env.NODE_ENV === "development"
        ? { details: e?.response?.data || e.message }
        : {}),
    });
  }
}

// Función auxiliar para obtener el desglose real de Guesty
async function getGuestyBreakdown(
  listingId,
  checkIn,
  checkOut,
  guests,
  commissionPct,
) {
  try {
    // Reutilizamos el endpoint de tu calculadora
    const payload = {
      listingId: listingId,
      checkInDateLocalized: checkIn,
      checkOutDateLocalized: checkOut,
      guestsCount: Number(guests) || 1,
      source: "villanet_email_system",
    };

    const guestyResp = await guesty.post("/v1/quotes", payload);

    // 🔥 USAMOS TU PARSER EXISTENTE (parseGuestyQuote)
    const parsed = parseGuestyQuote(guestyResp?.data);

    const base = Number(parsed.base) || 0;
    const cleaning = Number(parsed.cleaning) || 0;
    const taxes = Number(parsed.taxes) || 0;
    const otherFees = Number(parsed.otherFees) || 0;

    // Cálculo de comisión idéntico a la calculadora (Base + Limpieza + Taxes)
    const subtotal = base + cleaning + taxes;
    const commission = subtotal * (Number(commissionPct) / 100);
    const totalGross = subtotal + commission + otherFees;

    return {
      base,
      cleaning,
      taxes,
      otherFees,
      commission,
      totalGross,
      currency: parsed.currency || "USD",
    };
  } catch (error) {
    // LOG CRÍTICO: Aquí veremos por qué Guesty dice 400
    console.error(
      `⚠️ Breakdown falló para ${listingId}:`,
      e.response?.data?.message || e.response?.data || e.message,
    );
    return null;
  }
}
