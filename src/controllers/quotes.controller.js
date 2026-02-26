import { pool } from "../db.js";
import { sendEmail } from "../services/email.service.js";
import {
  getAvailabilityFor,
  checkStrictAvailability,
} from "../services/availability.service.js";
import pLimit from "p-limit";
import crypto from "crypto";
import {
  sendQuoteNotification,
  notifySafely,
} from "../services/discordNotification.service.js";
import {
  criticalError,
  partialError,
  validationError,
  notFoundError,
} from "../utils/errorResponse.js";
import { createOpenAPIQuote } from "../services/openApiQuote.service.js";
import { extractGuestyPriceBreakdown } from "../services/extractGuestyPriceBreakdown.js";



// ─── Date helpers ─────────────────────────────────────────────────────────────

function countStayNights(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function ymd10(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toYmd(d) {
  if (!d) return null;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

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

function buildGuestyUrl({
  domainOrUrl,
  listingId,
  checkInYmd,
  checkOutYmd,
  guests,
}) {
  const base = normalizeBaseUrl(domainOrUrl);
  const url = new URL(base);
  const id = encodeURIComponent(String(listingId));

  url.pathname = url.host.endsWith("guestybookings.com")
    ? `/en/properties/${id}`
    : `/villas/${id}`;

  const g = Number(guests);
  url.searchParams.set(
    "minOccupancy",
    String(Number.isFinite(g) && g > 0 ? g : 1),
  );
  if (checkInYmd) url.searchParams.set("checkIn", checkInYmd);
  if (checkOutYmd) url.searchParams.set("checkOut", checkOutYmd);
  return url.toString();
}

// ─── Controllers ──────────────────────────────────────────────────────────────

export async function quotesAvailabilityCheck(req, res) {
  try {
    const checkIn = ymd10(req.body?.checkIn);
    const checkOut = ymd10(req.body?.checkOut);
    const strict = Boolean(req.body?.strict);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!checkIn || !checkOut)
      return res
        .status(400)
        .json({ ok: false, error: "checkIn/checkOut requeridos (YYYY-MM-DD)" });
    if (new Date(checkIn) >= new Date(checkOut))
      return res
        .status(400)
        .json({ ok: false, error: "checkOut debe ser posterior a checkIn" });
    if (!items.length)
      return res.status(400).json({ ok: false, error: "items[] requerido" });

    const ids = [
      ...new Set(
        items
          .map((x) => String(x?.id || x?.listingId || "").trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length)
      return res
        .status(400)
        .json({ ok: false, error: "No hay listing IDs válidos" });

    const nights = countStayNights(checkIn, checkOut);
    const quick = await getAvailabilityFor(ids, checkIn, checkOut);
    const byId = new Map(quick.map((r) => [String(r.listing_id), r]));

    const results = ids.map((id) => {
      const r = byId.get(String(id));
      if (!r) return { listingId: id, available: null, reason: "no-result" };

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

    if (strict) {
      const limit = pLimit(2);
      const strictIds = results
        .filter((x) => x.available === true)
        .map((x) => x.listingId);
      const strictPairs = await Promise.all(
        strictIds.map((id) =>
          limit(async () => {
            try {
              return [id, await checkStrictAvailability(id, checkIn, checkOut)];
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

export async function createQuote(req, res) {
  const client = await pool.connect();
  try {
    const {
      guestFirstName,
      guestLastName,
      travelAdvisorEmail,
      guestEmail,
      checkIn,
      checkOut,
      guests,
      items,
    } = req.body;

    // Validaciones → 400 estandarizado
    if (!Array.isArray(items) || items.length === 0) {
      return validationError(res, {
        message: "Please add at least one property to the quote.",
        code: 'ITEMS_REQUIRED',
      });
    }

    const invalidItems = items.filter((item) => !item.id);
    if (invalidItems.length > 0) {
      return validationError(res, {
        message: "All properties must have a valid ID.",
        code: 'INVALID_ITEMS',
      });
    }

    await client.query("BEGIN");

    const quoteQuery = await client.query(
      `INSERT INTO quotes (created_by_user_id, guest_first_name, guest_last_name, travel_advisor_email, guest_email, check_in, check_out, guests, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft') RETURNING id, created_at`,
      [
        req.user?.id || null,
        guestFirstName?.trim() || null,
        guestLastName?.trim() || null,
        travelAdvisorEmail?.trim() || null,
        guestEmail?.trim() || null,
        checkIn || null,
        checkOut || null,
        guests || null,
      ]
    );
    const quoteId = quoteQuery.rows[0].id;

    for (const item of items) {
      if (!item.id) throw new Error(`Item without ID: ${JSON.stringify(item)}`);
      if (!item.guestyBookingDomain) throw new Error(`Missing guestyBookingDomain for property ${item.id}`);

      await client.query(
        `INSERT INTO quote_items (quote_id, listing_id, listing_name, listing_location, bedrooms, bathrooms, price_usd, image_url, guesty_booking_domain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (quote_id, listing_id) DO NOTHING`,
        [
          quoteId, item.id, item.name || null, item.location || null,
          item.bedrooms ?? null, item.bathrooms ?? null,
          item.priceUSD ? Number(item.priceUSD) : null,
          item.imageUrl || null, item.guestyBookingDomain,
        ]
      );
    }

    await client.query(
      `INSERT INTO quote_history (quote_id, event_type, actor_user_id, payload) VALUES ($1, 'CREATED', $2, $3)`,
      [quoteId, req.user?.id || null, JSON.stringify({
        itemsCount: items.length, guestFirstName, guestLastName,
        travelAdvisorEmail, guestEmail, checkIn, checkOut,
      })]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      quoteId,
      message: `Quote created with ${items.length} properties.`,
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error creating quote:", error);

    return criticalError(res, {
      status: 500,
      message: 'There was an error creating the quote. Please try again.',
      code: 'QUOTE_CREATE_FAILED',
      details: error.message,
    });
  } finally {
    client.release();
  }
}

export async function getQuoteDetails(req, res) {
  try {
    const { id } = req.params;
    const quoteResult = await pool.query(
      `SELECT q.*, u.email as created_by_email, u.full_name as created_by_name
       FROM quotes q LEFT JOIN users u ON q.created_by_user_id = u.id WHERE q.id = $1`,
      [id],
    );
    if (quoteResult.rows.length === 0)
      return res.status(404).json({ error: "Quote no encontrado" });

    const itemsResult = await pool.query(
      `SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY created_at`,
      [id],
    );
    const historyResult = await pool.query(
      `SELECT * FROM quote_history WHERE quote_id = $1 ORDER BY created_at DESC`,
      [id],
    );

    return res.json({
      quote: quoteResult.rows[0],
      items: itemsResult.rows,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error("❌ Error obteniendo quote:", error);
    return res.status(500).json({ error: "Error interno" });
  }
}

export async function sendQuoteEmail(req, res) {
  const client = await pool.connect();
  try {
    const {
      id,
    } = req.params;
    const {
      guestFirstName, guestLastName, travelAdvisorEmail,
      guestEmail, checkIn, checkOut, guests, items,
    } = req.body;

    const userId = req.user?.id;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Validaciones → 400 estandarizado
    if (!guestFirstName?.trim()) {
      return validationError(res, { message: "Guest first name is required.", code: 'VALIDATION_ERROR' });
    }
    if (!guestLastName?.trim()) {
      return validationError(res, { message: "Guest last name is required.", code: 'VALIDATION_ERROR' });
    }
    if (!travelAdvisorEmail?.trim()) {
      return validationError(res, { message: "Travel advisor email is required.", code: 'VALIDATION_ERROR' });
    }
    if (!emailRegex.test(travelAdvisorEmail)) {
      return validationError(res, { message: "Invalid travel advisor email format.", code: 'VALIDATION_ERROR' });
    }
    if (guestEmail && !emailRegex.test(guestEmail)) {
      return validationError(res, { message: "Invalid guest email format.", code: 'VALIDATION_ERROR' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return validationError(res, { message: "Items array is required.", code: 'VALIDATION_ERROR' });
    }

    await client.query("BEGIN");

    const updateResult = await client.query(
      `UPDATE quotes SET guest_first_name=$2, guest_last_name=$3, travel_advisor_email=$4, guest_email=$5,
       check_in=$6, check_out=$7, guests=$8, updated_at=NOW() WHERE id=$1 AND status='draft' RETURNING *`,
      [
        id, guestFirstName.trim(), guestLastName.trim(),
        travelAdvisorEmail.trim(), guestEmail?.trim() || null,
        checkIn || null, checkOut || null, guests || null,
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return notFoundError(res, {
        message: "Quote not found or already sent.",
        code: 'QUOTE_NOT_FOUND',
      });
    }

    const quote = updateResult.rows[0];

    const itemsResult = await client.query(

`SELECT qi.*,
        pm.logo_url as pm_logo_url, pm.name as pm_name
 FROM quote_items qi
 LEFT JOIN listings l ON qi.listing_id = l.listing_id
 LEFT JOIN listing_property_managers pm ON l.listing_property_manager_id = pm.id
 WHERE qi.quote_id = $1`, [id] 
    );
    const dbItems = itemsResult.rows;

    if (dbItems.length === 0) {
      await client.query("ROLLBACK");
      return validationError(res, {
        message: "The quote has no properties. Please add at least one villa.",
        code: 'ITEMS_REQUIRED',
      });
    }

    const checkInYmd  = toYmd(quote.check_in);
    const checkOutYmd = toYmd(quote.check_out);
    const hasDates    = checkInYmd && checkOutYmd;
    const nights      = hasDates ? countStayNights(checkInYmd, checkOutYmd) : 1;

    const itemsWithFullData = await Promise.all(
      dbItems.map(async (item) => {
        let breakdown = null;

        if (hasDates) {
          console.log("📅 Fechas entrando a OpenAPI:", { checkIn, checkOut, guests });
          breakdown = await getGuestyBreakdown(
            item.listing_id,
            checkInYmd,
            checkOutYmd,
            quote.guests,
            0,
            item.guesty_booking_domain
          );
        }

        const guestyUrl = buildGuestyUrl({
          domainOrUrl: item.guesty_booking_domain || "https://book.guesty.com",
          listingId: item.listing_id,
          checkInYmd, checkOutYmd, guests: quote.guests,
        });

        // Fallback si no hay breakdown
        if (!breakdown) {
          breakdown = {
            base: Number(item.price_usd) * nights,
            cleaning: 0,
            taxes: 0,
            otherFees: 0,
            feeBreakdown: [],
            feesTotal: 0,
            total: Number(item.price_usd) * nights,
            currency: "USD",
            priceSource: "fallback_estimate",
          };
        }

        return {
          ...item,
          guestyUrl,
          breakdown,
        };
      })
    );

    const pmLogoUrl = itemsWithFullData[0]?.pm_logo_url || null;
    const pmName    = itemsWithFullData[0]?.pm_name || "villanet";

    // ── Envío de emails con manejo de error PARCIAL ──────────────────────────
    const advisorHtml = await generateQuoteEmailHtml(
      { ...quote, recipient_type: "advisor" },
      itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName
    );

    let advisorEmailSent = false;
    let guestEmailSent   = false;
    let emailError       = null;

    try {
      await sendEmail({
        to: quote.travel_advisor_email,
        subject: `Your Quote for ${quote.guest_first_name} ${quote.guest_last_name}`,
        html: advisorHtml,
      });
      advisorEmailSent = true;
    } catch (err) {
      console.error("❌ Failed to send advisor email:", err);
      emailError = err;
    }

    if (advisorEmailSent && quote.guest_email?.trim()) {
      try {
        const guestHtml = await generateQuoteEmailHtml(
          { ...quote, recipient_type: "guest" },
          itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName
        );
        await sendEmail({
          to: quote.guest_email,
          subject: `Your Curated Villa Options — ${quote.guest_first_name} ${quote.guest_last_name}`,
          html: guestHtml,
        });
        guestEmailSent = true;
      } catch (err) {
        console.error("❌ Failed to send guest email:", err);
        emailError = err;
      }
    }

    // ── Si el email del advisor falló, NO marcamos el quote como 'sent'
    //    y retornamos error parcial para que el frontend pueda reintentar.
    if (!advisorEmailSent) {
      await client.query("ROLLBACK");
      return criticalError(res, {
        status: 500,
        message: "The quote was saved, but there was a problem sending the email. Please try again.",
        code: 'EMAIL_SEND_FAILED',
        details: emailError?.message,
      });
    }

    // ── El advisor recibió el email (éxito principal). Guardamos el estado.
    await client.query(`UPDATE quotes SET status='sent', updated_at=NOW() WHERE id=$1`, [id]);

    await client.query(
      `INSERT INTO quote_history (quote_id, event_type, actor_user_id, payload) VALUES ($1, 'SENT', $2, $3)`,
      [id, userId || null, JSON.stringify({
        guestFirstName: quote.guest_first_name,
        guestLastName: quote.guest_last_name,
        travelAdvisorEmail: quote.travel_advisor_email,
        guestEmailSent,
        checkIn: checkInYmd, checkOut: checkOutYmd,
        guests: quote.guests, itemsCount: itemsWithFullData.length,
      })]
    );
    
    // ✅ Usamos total en lugar de totalGross
    const totalQuoteAmount = itemsWithFullData.reduce((s, i) => s + (i.breakdown?.total || 0), 0);
    
    notifySafely(() =>
      sendQuoteNotification({
        quoteId: id,
        guestName: `${quote.guest_first_name} ${quote.guest_last_name}`,
        advisorEmail: quote.travel_advisor_email,
        guestEmail: quote.guest_email || "Not provided",
        villas: itemsWithFullData.map((i) => ({ 
          name: i.listing_name, 
          price: i.breakdown.total  // ✅ Usamos total
        })),
        checkIn: checkInYmd,
        checkOut: checkOutYmd,
        guests: quote.guests,
        totalPrice: totalQuoteAmount,
        downloadUrl: itemsWithFullData[0]?.guestyUrl,
      })
    );

    await client.query("COMMIT");

    // ── Si el email del guest falló, respuesta parcial (207)
    if (quote.guest_email?.trim() && !guestEmailSent) {
      return partialError(res, {
        message: `Email sent to ${quote.travel_advisor_email}, but the guest copy failed to send.`,
        code: 'EMAIL_GUEST_FAILED',
        data: {
          quoteId: id,
          emailsSent: { advisor: quote.travel_advisor_email, guest: null },
        },
      });
    }

    // ── Éxito total
    return res.json({
      success: true,
      message: guestEmail
        ? `Emails sent to ${quote.travel_advisor_email} and ${quote.guest_email}`
        : `Email sent to ${quote.travel_advisor_email}`,
      quoteId: id,
      emailsSent: {
        advisor: quote.travel_advisor_email,
        guest: guestEmailSent ? quote.guest_email : null,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error in sendQuoteEmail:", error);

    return criticalError(res, {
      status: 500,
      message: 'There was an error sending the quote. Please try again.',
      code: 'EMAIL_SEND_FAILED',
      details: error.message,
    });
  } finally {
    client.release();
  }
}

// ─── Email template ───────────────────────────────────────────────────────────

export async function generateQuoteEmailHtml(
  quote,
  items,
  nights,
  checkInYmd,
  checkOutYmd,
  pmLogoUrl = null,
  pmName = "villanet",
) {
  const formatDate = (dateStr) => {
    if (!dateStr) return "Flexible Dates";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  };

  const fmt = (amount) => {
    if (!amount && amount !== 0) return "Contact for pricing";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const safeNights = nights || 1;
  const isGuest = quote.recipient_type === "guest";
  const greeting = isGuest
    ? `Hello, ${quote.guest_first_name}`
    : `Hello, Travel Advisor`;
  const intro = isGuest
    ? `Here are your curated villa options, handpicked based on your preferences.`
    : `Here is the quote prepared for your client, <strong style="font-weight:600;">${quote.guest_first_name} ${quote.guest_last_name}</strong>.`;

  // PNG icons — email-safe (no SVG)
  const iconPin   = `<img src="https://img.icons8.com/?size=100&id=3723&format=png&color=71717a"   width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  const iconBed   = `<img src="https://img.icons8.com/?size=100&id=7546&format=png&color=71717a"   width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  const iconBath  = `<img src="https://img.icons8.com/?size=100&id=11485&format=png&color=71717a"  width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  const iconCal   = `<img src="https://img.icons8.com/?size=100&id=23&format=png&color=71717a"     width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  const iconNight = `<img src="https://img.icons8.com/?size=100&id=660&format=png&color=71717a"    width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  const iconGuest = `<img src="https://img.icons8.com/?size=100&id=fEZo4zNy3Mqa&format=png&color=71717a" width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;

  const logo = '<img src="https://imagenes-logos-villanet.s3.us-east-1.amazonaws.com/logo-villanet.png" alt="VillaNet" width="160" style="display:block;margin:0 auto;max-height:50px;width:auto;" border="0">';

  // ── Inline style constants (mantienen consistencia y sobreviven forward) ──
  const S = {
    body:        "margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#09090b;",
    outerTable:  "border-collapse:collapse;width:100%;background-color:#f4f4f5;",
    wrap:        "width:600px;max-width:600px;",

    // Header
    hdCell:      "background-color:#ffffff;padding:36px 40px 28px;text-align:center;border-bottom:1px solid #e5e7eb;",
    hdLabel:     "font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin:0 0 20px 0;",
    hdH1:        "font-size:26px;font-weight:600;color:#09090b;line-height:1.2;margin:16px 0 10px 0;",
    hdP:         "font-size:14px;color:#52525b;line-height:1.6;margin:0;",

    // Trip bar
    tripCell:    "background-color:#ffffff;padding:20px 40px;border-bottom:1px solid #e5e7eb;",
    tcLabel:     "font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#71717a;margin:0 0 3px 0;",
    tcVal:       "font-weight:600;color:#09090b;font-size:13px;margin:0;",
    tripTd:      "width:25%;padding:10px 12px;vertical-align:middle;",
    tripTdBorder:"width:25%;padding:10px 12px;vertical-align:middle;border-left:1px solid #e5e7eb;",

    // Content wrapper
    contentCell: "padding:24px 40px 32px;background-color:#f4f4f5;",

    // Card
    cardTable:   "border-collapse:collapse;width:100%;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:20px;",
    cardImg:     "width:100%;height:220px;object-fit:cover;display:block;",
    cardBodyTd:  "padding:22px 24px 24px;",
    cardTitle:   "font-size:18px;font-weight:600;color:#09090b;margin:0 0 12px 0;line-height:1.3;",
    cardMetaP:   "font-size:13px;color:#71717a;margin:0 0 5px 0;line-height:1.4;",

    // Breakdown box
    bdTable:     "border-collapse:collapse;width:100%;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;",
    bdTd:        "padding:16px 18px 0 18px;",
    bdRowTable:  "border-collapse:collapse;width:100%;",
    bdRow:       "border-top:1px solid #f0f0f0;",
    bdLabel:     "font-size:13px;color:#52525b;padding:6px 0;vertical-align:middle;",
    bdVal:       "font-size:13px;font-weight:600;color:#09090b;text-align:right;padding:6px 0;vertical-align:middle;",
    bdTotalLabel:"font-size:14px;font-weight:600;color:#09090b;padding:10px 0 16px 0;vertical-align:middle;border-top:2px solid #e5e7eb;",
    bdTotalVal:  "font-size:16px;font-weight:700;color:#09090b;text-align:right;padding:10px 0 16px 0;vertical-align:middle;border-top:2px solid #e5e7eb;",

    // CTA Button
btnTd:       "padding:0;text-align:center;background-color:#09090b;border-radius:8px;",
btn:         "display:block;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.02em;padding:13px 28px;text-align:center;font-family:Arial,Helvetica,sans-serif;",

    // Footer
    ftCell:      "background-color:#fafafa;padding:28px 40px;text-align:center;border-top:1px solid #e5e7eb;",
    ftP:         "font-size:12px;color:#71717a;margin:4px 0;line-height:1.6;",
  };

  // ── Trip bar cells ────────────────────────────────────────────────────────
  const tripCells = [
    { icon: iconCal,   label: "Check-in",  val: formatDate(checkInYmd) },
    { icon: iconCal,   label: "Check-out", val: formatDate(checkOutYmd) },
    { icon: iconNight, label: "Nights",    val: safeNights },
    ...(quote.guests ? [{ icon: iconGuest, label: "Guests", val: quote.guests }] : []),
  ];

  const tripCellsHtml = tripCells
    .map((c, i) => `
      <td style="${i === 0 ? S.tripTd : S.tripTdBorder}">
        <p style="${S.tcLabel}">${c.icon} ${c.label}</p>
        <p style="${S.tcVal}">${c.val}</p>
      </td>`)
    .join("");

  // ── Villa cards ───────────────────────────────────────────────────────────
  const cardsHtml = items
    .map((item) => {
      const b = item.breakdown;
      if (!b) return "";

      // Fee rows
      const feeRows = (() => {
        if (b.feeBreakdown?.length > 0) {
          return b.feeBreakdown
            .filter((f) => f.amount > 0)
            .map(
              (f) => `
              <tr style="${S.bdRow}">
                <td style="${S.bdLabel}">${f.title}</td>
                <td style="${S.bdVal}">${fmt(f.amount)}</td>
              </tr>`
            )
            .join("");
        }
        if (b.otherFees > 0) {
          return `
            <tr style="${S.bdRow}">
              <td style="${S.bdLabel}">Other Fees</td>
              <td style="${S.bdVal}">${fmt(b.otherFees)}</td>
            </tr>`;
        }
        return "";
      })();

      const feesTotalRow =
        Number(b.feesTotal) > 0
          ? `<tr style="${S.bdRow}">
               <td style="${S.bdLabel}">Fees</td>
               <td style="${S.bdVal}">${fmt(b.feesTotal)}</td>
             </tr>`
          : "";

      return `
    <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table cellpadding="0" cellspacing="0" border="0" style="${S.cardTable}">
      ${
        item.image_url
          ? `<tr>
               <td style="padding:0;line-height:0;">
                 <img src="${item.image_url}" width="600" style="${S.cardImg}" alt="${item.listing_name || "Villa"}">
               </td>
             </tr>`
          : ""
      }
      <tr>
        <td style="${S.cardBodyTd}">

          <!-- Title -->
          <p style="${S.cardTitle}">${item.listing_name || "Luxury Villa"}</p>

          <!-- Meta -->
          <p style="${S.cardMetaP}">${iconPin}${item.listing_location || ""}</p>
          <p style="${S.cardMetaP}">${iconBed}${item.bedrooms} Bedrooms &nbsp;&middot;&nbsp; ${iconBath}${item.bathrooms} Bathrooms</p>

          <!-- Breakdown box -->
          <table cellpadding="0" cellspacing="0" border="0" style="${S.bdTable}">
            <tr>
              <td style="${S.bdTd}">
                <table cellpadding="0" cellspacing="0" border="0" style="${S.bdRowTable}">
                  <!-- Base -->
                  <tr>
                    <td style="${S.bdLabel}">Base Rate (${safeNights} night${safeNights !== 1 ? "s" : ""})</td>
                    <td style="${S.bdVal}">${fmt(b.base)}</td>
                  </tr>
                  ${
                    b.cleaning > 0
                      ? `<tr style="${S.bdRow}">
                           <td style="${S.bdLabel}">Cleaning Fee</td>
                           <td style="${S.bdVal}">${fmt(b.cleaning)}</td>
                         </tr>`
                      : ""
                  }
                  ${feesTotalRow}
                  ${feeRows}
                  ${
                    b.taxes > 0
                      ? `<tr style="${S.bdRow}">
                           <td style="${S.bdLabel}">Taxes</td>
                           <td style="${S.bdVal}">${fmt(b.taxes)}</td>
                         </tr>`
                      : ""
                  }
                  <!-- Total -->
                  <tr>
                    <td style="${S.bdTotalLabel}">Total</td>
                    <td style="${S.bdTotalVal}">${fmt(b.total)}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>

          <!-- CTA Button -->
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
            <tr>
              <!--[if mso]>
              <td style="padding:0;background-color:#09090b;border-radius:8px;">
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                  href="${item.guestyUrl}"
                  style="height:46px;v-text-anchor:middle;width:504px;" arcsize="10%" stroke="f" fillcolor="#09090b">
                  <w:anchorlock/>
                  <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;">
                    View Photo Gallery &amp; Details &rarr;
                  </center>
                </v:roundrect>
              </td>
              <![endif]-->
              <!--[if !mso]><!-->
              <td style="padding:0;background-color:#09090b;border-radius:8px;">
                <a href="${item.guestyUrl}" style="${S.btn}">
                  View Photo Gallery &amp; Details &rarr;
                </a>
              </td>
              <!--<![endif]-->
            </tr>
          </table>

        </td>
      </tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
    <div style="height:20px;line-height:20px;font-size:20px;">&nbsp;</div>`;
    })
    .join("");

    return `<!DOCTYPE html>
    <html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="x-apple-disable-message-reformatting">
      <!--[if mso]>
      <noscript><xml>
        <o:OfficeDocumentSettings>
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml></noscript>
      <![endif]-->
      <title>Your Curated Villa Options</title>
      <style>
        /* RESET ONLY — no layout styles here (they'd be stripped on forward) */
        body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
        table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
        img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
        /* Responsive — survives forward better than layout styles */
        @media only screen and (max-width: 620px) {
          .wrap { width: 100% !important; max-width: 100% !important; }
          .trip-td { display: block !important; width: 100% !important; border-left: none !important; border-bottom: 1px solid #e5e7eb !important; padding: 8px 0 !important; }
          .card-img { height: 180px !important; }
          .pad { padding-left: 20px !important; padding-right: 20px !important; }
        }
      </style>
    </head>
    <body style="${S.body}">
    
    <!-- Preheader (hidden) -->
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
      Villa options for ${quote.guest_first_name} ${quote.guest_last_name} — ${formatDate(checkInYmd)} to ${formatDate(checkOutYmd)}
      ${crypto.randomBytes(8).toString("hex")}
    </div>
    
    <!-- Outer wrapper -->
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="${S.outerTable}">
      <tr>
        <td align="center" style="padding:24px 0;">
    
          <!-- Inner 600px container -->
          <table cellpadding="0" cellspacing="0" border="0" role="presentation" class="wrap" style="${S.wrap}">
    
            <!-- ══ HEADER ══ -->
            <tr>
              <td class="pad" style="${S.hdCell}">
                <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                  <tr>
                    <td style="padding:0;text-align:center;">
                      ${logo}
                    </td>
                  </tr>
                </table>
                <h1 style="${S.hdH1}">Your Curated Villa Options</h1>
                <p style="${S.hdP}">${greeting}! ${intro}</p>
              </td>
            </tr>
    
            <!-- ══ TRIP BAR ══ -->
            <tr>
              <td class="pad" style="${S.tripCell}">
                <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;width:100%;">
                  <tr>
                    ${tripCellsHtml}
                  </tr>
                </table>
              </td>
            </tr>
    
            <!-- ══ VILLA CARDS ══ -->
            <tr>
              <td class="pad" style="${S.contentCell}">
                ${cardsHtml}
              </td>
            </tr>
    
            <!-- ══ FOOTER ══ -->
            <tr>
              <td class="pad" style="${S.ftCell}">
                <p style="${S.ftP}">Book with Confidence. Earn with Trust.</p>
                <p style="${S.ftP}">This quote was generated by VillaNet — connecting you with the world's most vetted villas.</p>
                ${
                  !isGuest
                    ? `<p style="${S.ftP}">Questions? Reply to this email or contact your client directly.</p>`
                    : `<p style="${S.ftP}">Questions? Contact your travel advisor directly.</p>`
                }
              </td>
            </tr>
    
          </table>
          <!-- /Inner container -->
    
        </td>
      </tr>
    </table>
    <!-- /Outer wrapper -->
    
    </body>
    </html>`;
    }

// ─── Additional controllers ───────────────────────────────────────────────────

export async function checkQuotesAvailability(req, res) {
  try {
    const { checkIn, checkOut, guests, items } = req.body || {};
    if (!checkIn || !checkOut)
      return res
        .status(400)
        .json({ ok: false, error: "checkIn y checkOut son requeridos" });
    if (!Array.isArray(items) || items.length === 0)
      return res
        .status(400)
        .json({ ok: false, error: "items es requerido (array)" });

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function money2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function sumByPred(items, pred) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    if (!it || !pred(it)) continue;
    const amt = Number(
      it.amount ??
        it.total ??
        it.value ??
        it.price ??
        it.netAmount ??
        it.grossAmount ??
        it.gross,
    );
    if (Number.isFinite(amt)) total += amt;
  }
  return total;
}

function safeJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function clampPct(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 0;
}

// ─── Guesty quote parsers ────────────────────────────────────────────────────

function parseGuestyQuote(raw) {
  const q = raw?.data ?? raw ?? {};

  const invoiceItems =
    q?.rates?.ratePlans?.[0]?.money?.money?.invoiceItems ||
    q?.rates?.ratePlans?.[0]?.money?.invoiceItems ||
    q?.rates?.ratePlans?.[0]?.invoiceItems ||
    q?.money?.invoiceItems ||
    q?.invoiceItems ||
    q?.price?.invoiceItems ||
    q?.priceBreakdown?.invoiceItems ||
    [];

  const parsed = parseInvoiceItems(invoiceItems);
  return {
    currency: parsed.currency,
    base: parsed.base,
    cleaning: parsed.cleaning,
    taxes: parsed.taxes,
    otherFees: parsed.otherFees,
    feeBreakdown: parsed.feeBreakdown,
    invoiceItems,
  };
}

export async function calculateQuote(req, res) {
  const requestId = `qcalc_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  try {
    const listingId = String(req.body?.listingId || "").trim();
    const checkIn = String(req.body?.checkIn || "").trim();
    const checkOut = String(req.body?.checkOut || "").trim();
    const guestsCount = Math.max(1, Math.floor(Number(req.body?.guests ?? req.body?.guestsCount ?? 1)));
    const commissionPct = clampPct(req.body?.commissionPct ?? 0);

    if (!listingId || !isYmd(checkIn) || !isYmd(checkOut) || new Date(checkIn) >= new Date(checkOut)) {
      return res.status(400).json({ ok: false, error: "Parámetros inválidos" });
    }

    const nights = countStayNights(checkIn, checkOut);

    // Solo Open API (ya no fallback a BE ni cálculo manual)
    const quote = await createOpenAPIQuote({
      listingId,
      checkIn,
      checkOut,
      guestsCount,
      source: "manual", // "manual" devuelve invoice items completos (fees incluidos)
    });

    const breakdown = extractGuestyPriceBreakdown(quote);

    const commission = breakdown.total * (commissionPct / 100);
    const totalGross = breakdown.total + commission;

    const response = {
      ok: true,
      currency: breakdown.currency,
      nights,
      breakdown: {
        base: money2(breakdown.base),
        cleaning: money2(breakdown.cleaning || 0),
        taxes: money2(breakdown.taxes),
        feeBreakdown: breakdown.feeBreakdown,
        feesTotal: money2(breakdown.feesTotal),
        // total = lo que el cliente paga en Guesty (igual que en sendQuoteEmail)
        total: money2(breakdown.total),
        commissionPct,
        commission: money2(commission),
        totalGross: money2(totalGross),
      },
      source: "open-api",
      ...(process.env.NODE_ENV === "development" && { debug: { requestId } }),
    };

    return res.json(response);
  } catch (e) {
    console.error(`🔥 [${requestId}] error`, e);
    return res.status(502).json({
      ok: false,
      error: "guesty_quote_failed",
      message: "Could not retrieve a quote from Guesty",
    });
  }
}

/**
 * Helper para parsear invoice items de Guesty
 * Separa en: base, cleaning, taxes, y otros fees
 */
function parseInvoiceItems(invoiceItems) {
  if (!Array.isArray(invoiceItems) || invoiceItems.length === 0) {
    return {
      base: 0,
      cleaning: 0,
      taxes: 0,
      otherFees: 0,
      feeBreakdown: [],
      currency: "USD",
    };
  }

  // Base (Accommodation Fare)
  const base = sumByPred(invoiceItems, (it) => {
    const type = String(it.type || it.normalType || "").toUpperCase();
    return (
      type.includes("ACCOMMODATION") ||
      type === "AF" ||
      type === "ACCOMMODATION_FARE"
    );
  });

  // Cleaning Fee
  const cleaning = sumByPred(invoiceItems, (it) => {
    const type = String(
      it.type || it.normalType || it.title || "",
    ).toLowerCase();
    return type.includes("clean") || it.normalType === "CF";
  });

  // Taxes
  const taxes = sumByPred(invoiceItems, (it) => {
    const type = String(it.type || it.normalType || "").toUpperCase();
    return (
      type.includes("TAX") ||
      it.isTax === true ||
      type === "LT" ||
      type === "TAX"
    );
  });

  // Otros Fees (TODO lo que no sea base, cleaning o tax)
  const otherFees = sumByPred(invoiceItems, (it) => {
    const type = String(it.type || it.normalType || "").toUpperCase();
    const isBase =
      type.includes("ACCOMMODATION") ||
      type === "AF" ||
      type === "ACCOMMODATION_FARE";
    const isCleaning = type.includes("CLEAN") || type === "CF";
    const isTax =
      type.includes("TAX") ||
      it.isTax === true ||
      type === "LT" ||
      type === "TAX";
    return !isBase && !isCleaning && !isTax;
  });

  // Desglose individual de cada fee
  const feeBreakdown = invoiceItems
    .filter((it) => {
      const type = String(it.type || it.normalType || "").toUpperCase();
      const isBase =
        type.includes("ACCOMMODATION") ||
        type === "AF" ||
        type === "ACCOMMODATION_FARE";
      const isCleaning = type.includes("CLEAN") || type === "CF";
      const isTax =
        type.includes("TAX") ||
        it.isTax === true ||
        type === "LT" ||
        type === "TAX";
      return !isBase && !isCleaning && !isTax;
    })
    .map((it) => ({
      title: it.title || it.name || "Fee",
      amount: Number(it.amount) || 0,
      type: it.type || it.normalType || "FEE",
    }));

  const currency = invoiceItems[0]?.currency || "USD";

  return { base, cleaning, taxes, otherFees, feeBreakdown, currency };
}

async function getGuestyBreakdown(listingId, checkIn, checkOut, guests, commissionPct = 0, bookingDomain = null) {
  let quoteData = null;
  let sourceUsed = "open-api";

  try {
    quoteData = await createOpenAPIQuote({
      listingId,
      checkIn,
      checkOut,
      guestsCount: Number(guests) || 1,
      source: "manual", 
    });
  } catch (openErr) {
    console.warn(`OpenAPI falló (${openErr.response?.status}):`, openErr.response?.data);
    sourceUsed = "fallback-manual";
    // Aquí podrías agregar fallback real si lo necesitas
  }

  if (!quoteData) {
    return null; 
  }

  const breakdown = extractGuestyPriceBreakdown(quoteData);
  
  return {
    currency: breakdown.currency,
    nights: countStayNights(checkIn, checkOut),
    base: breakdown.base,
    taxes: breakdown.taxes,
    feeBreakdown: breakdown.feeBreakdown,
    feesTotal: breakdown.feesTotal,
    total: breakdown.total,
    priceSource: sourceUsed,
    internal: {
      villanetCommission: breakdown.total * (commissionPct / 100),
      commissionPct,
    },
  };
}