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
  if (!domainOrUrl || typeof domainOrUrl !== "string") {
    console.warn("⚠️  [buildGuestyUrl] guesty_booking_domain is null/empty — falling back to default domain. Check listings table.");
    return "https://villanet.guestybookings.com";
  }
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
        req.user?.sub || null,
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
      [quoteId, req.user?.sub || null, JSON.stringify({
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
      displayCurrency = 'USD',
    } = req.body;

    // Validar moneda
    const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'CAD'];
    const safeCurrency = SUPPORTED_CURRENCIES.includes(displayCurrency) ? displayCurrency : 'USD';

    const userId = req.user?.sub;
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
        COALESCE(qi.guesty_booking_domain, l.guesty_booking_domain) AS guesty_booking_domain,
        pm.logo_url as pm_logo_url, pm.name as pm_name,
        l.amenities_json,
        l.villanet_chef_included,
        l.villanet_cook_included,
        l.villanet_waiter_butler_included,
        l.villanet_private_gym,
        l.villanet_private_cinema,
        l.villanet_pickleball,
        l.villanet_tennis,
        l.villanet_golf_cart_included,
        l.villanet_golf_villa
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
          domainOrUrl: item.guesty_booking_domain,
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

    // ── TA branding: avatar_url, full_name (users) + first_name (advisors) ────
    let taLogoUrl    = null;
    let taName       = null;
    let taFirstName  = null;
    if (userId) {
      const taResult = await client.query(
        `SELECT u.avatar_url, u.full_name, u.email, a.first_name
         FROM users u
         LEFT JOIN advisors a ON LOWER(a.email) = LOWER(u.email)
         WHERE u.id = $1`,
        [userId]
      );
      if (taResult.rows.length > 0) {
        const row    = taResult.rows[0];
        taLogoUrl    = row.avatar_url?.trim()  || null;
        taName       = row.full_name?.trim()   || null;
        taFirstName  = row.first_name?.trim()  || null;
      }
    }

    // ── Icon attachments (embedded CID — no external URLs needed) ───────────
    const ICONS_DIR = "./src/assets/icons";
    const iconAttachments = [
      { filename: "map-pin.png",             path: `${ICONS_DIR}/map-pin.png`,             cid: "map-pin@villanet"             },
      { filename: "bed-double.png",          path: `${ICONS_DIR}/bed-double.png`,          cid: "bed-double@villanet"          },
      { filename: "bath.png",                path: `${ICONS_DIR}/bath.png`,                cid: "bath@villanet"                },
      { filename: "calendar-arrow-up.png",   path: `${ICONS_DIR}/calendar-arrow-up.png`,   cid: "calendar-arrow-up@villanet"   },
      { filename: "calendar-arrow-down.png", path: `${ICONS_DIR}/calendar-arrow-down.png`, cid: "calendar-arrow-down@villanet" },
      { filename: "cloud-moon.png",          path: `${ICONS_DIR}/cloud-moon.png`,          cid: "cloud-moon@villanet"          },
      ...(quote.guests ? [{ filename: "users.png", path: `${ICONS_DIR}/users.png`, cid: "users@villanet" }] : []),
      { filename: "square-check-big.png",    path: `${ICONS_DIR}/square-check-big.png`,    cid: "square-check-big@villanet"    },
      { filename: "plane.png",               path: `${ICONS_DIR}/plane.png`,               cid: "plane@villanet"               },
      { filename: "car.png",                 path: `${ICONS_DIR}/car.png`,                 cid: "car@villanet"                 },
      { filename: "shopping-cart.png",       path: `${ICONS_DIR}/shopping-cart.png`,       cid: "shopping-cart@villanet"       },
      { filename: "chef-hat.png",            path: `${ICONS_DIR}/chef-hat.png`,            cid: "chef-hat@villanet"            },
      { filename: "sparkles.png",            path: `${ICONS_DIR}/sparkles.png`,            cid: "sparkles@villanet"            },
      { filename: "dumbbell.png",            path: `${ICONS_DIR}/dumbbell.png`,            cid: "dumbbell@villanet"            },
      { filename: "baby.png",                path: `${ICONS_DIR}/baby.png`,                cid: "baby@villanet"                },
      { filename: "party-popper.png",        path: `${ICONS_DIR}/party-popper.png`,        cid: "party-popper@villanet"        },
    ];

    // ── Envío de emails con manejo de error PARCIAL ──────────────────────────
    const advisorHtml = await generateQuoteEmailHtml(
      { ...quote, recipient_type: "advisor" },
      itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName,
      taLogoUrl, taName, taFirstName,
      safeCurrency
    );

    let advisorEmailSent = false;
    let guestEmailSent   = false;
    let emailError       = null;

    try {
      await sendEmail({
        to: quote.travel_advisor_email,
        subject: `Your Quote for ${quote.guest_first_name} ${quote.guest_last_name}`,
        html: advisorHtml,
        attachments: iconAttachments,
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
          itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName,
          taLogoUrl, taName, taFirstName,
          safeCurrency
        );
        await sendEmail({
          to: quote.guest_email,
          subject: `Your Curated Villa Options — ${quote.guest_first_name} ${quote.guest_last_name}`,
          html: guestHtml,
          attachments: iconAttachments,
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
  taLogoUrl = null,
  taName = null,
  taFirstName = null,
  displayCurrency = 'USD',
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
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  // ── Currency conversion (indicative, display only) ──────────────────────
  const DISPLAY_RATES = { USD: 1.00, EUR: 0.92, CAD: 1.36 };
  const DISPLAY_SYMBOLS = { USD: '$', EUR: '€', CAD: 'CA$' };
  const RATE_DATE = 'Apr 2025';

  const showAltCurrency = displayCurrency !== 'USD';
  const altRate   = DISPLAY_RATES[displayCurrency] || 1;

  const fmtAlt = (amountUSD) => {
    if (!amountUSD && amountUSD !== 0) return '';
    const converted = amountUSD * altRate;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: displayCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(converted);
  };

  const safeNights = nights || 1;
  const isGuest = quote.recipient_type === "guest";
  const greeting = isGuest
    ? `Hello, ${quote.guest_first_name}`
    : `Hello, ${taFirstName || "Travel Advisor"}`;
  const intro = isGuest
    ? `Here are your curated villa options, handpicked based on your preferences.`
    : `Here is the quote prepared for your client, <strong style="font-weight:600;">${quote.guest_first_name} ${quote.guest_last_name}</strong>.`;

  // PNG icons — embedded as CID attachments (email-safe, no external URLs)
  // Helper: renders a small inline CID icon (13px, used in cards/trip bar)
  const icon13 = (cid) => `<img src="cid:${cid}@villanet" width="13" height="13" style="vertical-align:middle;margin-right:5px;display:inline;" alt="">`;
  // Helper: renders a larger inline CID icon (14px, used in services section)
  const icon14 = (cid) => `<img src="cid:${cid}@villanet" width="14" height="14" style="vertical-align:middle;margin-right:6px;display:inline;" alt="">`;

  // ── Header branding: TA logo > TA name > VillaNet logo (fallback) ──────────
  let headerBrandHtml;
  if (taLogoUrl) {
    // Escenario A: TA tiene logo cargado
    headerBrandHtml = `<img src="${taLogoUrl}" alt="Agency Logo"
      style="display:block;margin:0 auto;max-width:220px;max-height:80px;width:auto;height:auto;" border="0">`;
  } else if (taName) {
    // Escenario B: TA tiene nombre pero no logo
    headerBrandHtml = `<p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.01em;color:#09090b;font-family:Georgia,'Times New Roman',serif;">${taName}</p>`;
  } else {
    // Fallback final: logo de VillaNet
    headerBrandHtml = `<img src="https://imagenes-logos-villanet.s3.us-east-1.amazonaws.com/logo-villanet.png" alt="VillaNet"
      width="160" style="display:block;margin:0 auto;max-height:50px;width:auto;" border="0">`;
  }

  // ── Inline style constants (mantienen consistencia y sobreviven forward) ──
  const S = {
    body:        "margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#09090b;",
    outerTable:  "border-collapse:collapse;width:100%;background-color:#f4f4f5;",
    wrap:        "width:660px;max-width:660px;min-width:280px;",

    // Header
    hdCell:      "background-color:#ffffff;padding:36px 40px 28px;text-align:center;border-bottom:1px solid #e5e7eb;",
    hdLabel:     "font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin:0 0 20px 0;",
    hdH1:        "font-size:26px;font-weight:600;color:#09090b;line-height:1.2;margin:16px 0 10px 0;",
    hdP:         "font-size:14px;color:#52525b;line-height:1.6;margin:0;",

    // Trip bar
    tripCell:    "background-color:#ffffff;padding:20px 40px;border-bottom:1px solid #e5e7eb;",
    tcLabel:     "font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#71717a;margin:0 0 6px 0;line-height:1.4;",
    tcVal:       "font-weight:600;color:#09090b;font-size:13px;margin:0;",
    tripTd:      "width:25%;padding:10px 12px;vertical-align:top;",
    tripTdBorder:"width:25%;padding:10px 12px;vertical-align:top;border-left:1px solid #e5e7eb;",

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
    { icon: icon13("calendar-arrow-up"),   label: "Check-in",  val: formatDate(checkInYmd) },
    { icon: icon13("calendar-arrow-down"), label: "Check-out", val: formatDate(checkOutYmd) },
    { icon: icon13("cloud-moon"),          label: "Nights",    val: safeNights },
    ...(quote.guests ? [{ icon: icon13("users"), label: "Guests", val: quote.guests }] : []),
  ];

  const tripCellsHtml = tripCells
    .map((c, i) => `
      <td class="trip-td" valign="top" style="${i === 0 ? S.tripTd : S.tripTdBorder}">
        <p style="${S.tcLabel}">${c.icon} ${c.label}</p>
        <p style="${S.tcVal}">${c.val}</p>
      </td>`)
    .join("");

  // ── Villa services helpers ────────────────────────────────────────────────

  /**
   * Builds the "What's Included" block for a villa card.
   * Reads the villanet_* boolean columns from the listings row (already joined).
   */
  function buildServicesBlock(item) {
    // Map each service to a human-readable label
    const SERVICES = [
      { key: "villanet_chef_included",         label: "Private Chef"},
      { key: "villanet_cook_included",          label: "Cook"},
      { key: "villanet_waiter_butler_included", label: "Waiter / Butler"},
      { key: "villanet_private_gym",            label: "Private Gym"},
      { key: "villanet_private_cinema",         label: "Private Cinema"},
      { key: "villanet_pickleball",             label: "Pickleball Court"},
      { key: "villanet_tennis",                 label: "Tennis Court",},
      // Golf cart is relevant when the property is a golf villa OR explicitly included
      { key: "villanet_golf_cart_included",     label: "Golf Cart",},
    ];

    const included = [];

    for (const svc of SERVICES) {
      // Special case: golf cart — show as included only when villanet_golf_villa is also true
      if (svc.key === "villanet_golf_cart_included") {
        if (item[svc.key] === true || item.villanet_golf_villa === true) {
          included.push(svc);
        }
        continue;
      }
      if (item[svc.key] === true) {
        included.push(svc);
      }
    }

    // If nothing included, skip the whole block
    if (included.length === 0) return "";

    const badgeStyle  = "display: inline-block;background-color: #ffffff;color: #111827;border: 1px solid #e5e7eb;border-radius: 20px;padding: 4px 12px;font-size: 11px;font-weight: 600;margin: 3px 4px 3px 0;white-space: nowrap;letter-spacing: 0.025em;";
    const sectionHead = "font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin:0 0 8px 0;";

    let html = `<div style="margin:14px 0 18px 0;">`;
    html += `<p style="${sectionHead}">${icon13("square-check-big")} What's Included</p>`;
    html += `<div>`;
    for (const svc of included) {
      html += `<span style="${badgeStyle}">${svc.label}</span>`;
    }
    html += `</div>`;
    html += `</div>`;
    return html;
  }

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
               <td style="${S.bdLabel}">Fees subtotal</td>
               <td style="${S.bdVal}">${fmt(b.feesTotal)}</td>
             </tr>`
          : "";

      return `
    <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table cellpadding="0" cellspacing="0" border="0" style="${S.cardTable}">
      ${
        item.image_url
          ? `<tr>
               <td class="card-img-td" style="padding:0;line-height:0;font-size:0;">
                 <img src="${item.image_url}" width="100%" class="card-img" style="${S.cardImg}" alt="${item.listing_name || "Villa"}">
               </td>
             </tr>`
          : ""
      }
      <tr>
        <td style="${S.cardBodyTd}">

          <!-- Title -->
          <p style="${S.cardTitle}">${item.listing_name || "Luxury Villa"}</p>

          <!-- Meta -->
          <p style="${S.cardMetaP}">${icon13("map-pin")}${item.listing_location || ""}</p>
          <p style="${S.cardMetaP}">${icon13("bed-double")}${item.bedrooms} Bedrooms &nbsp;&middot;&nbsp; ${icon13("bath")}${item.bathrooms} Bathrooms</p>

          <!-- Services: included + extras -->
          ${buildServicesBlock(item)}

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
                  ${showAltCurrency ? `
                  <tr>
                    <td colspan="2" style="padding:4px 0 10px 0;font-size:11px;color:#71717a;text-align:right;">
                      ≈ ${fmtAlt(b.total)} ${displayCurrency}
                      &nbsp;·&nbsp; indicative rate
                    </td>
                  </tr>` : ''}
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

  // ── Services section ──────────────────────────────────────────────────────

  const EXTRA_SERVICES = [
    { cid: "plane",         label: "Private Airport Transfers",                     desc: "Seamless arrival &amp; departure planning." },
    { cid: "car",           label: "Rental Vehicles Delivered to Your Villa",        desc: "Skip the rental counter entirely." },
    { cid: "shopping-cart", label: "Grocery Pre-Stocking &amp; Customized Menu Planning", desc: "Arrive to a fully prepared kitchen." },
    { cid: "chef-hat",      label: "Private Chef or Chef-On-Request",                desc: "Local, professional, and destination-savvy chefs." },
    { cid: "sparkles",      label: "Spa &amp; Massage Treatments In-Villa",          desc: "Therapists come directly to the villa." },
    { cid: "dumbbell",      label: "Fitness, Yoga, &amp; Personal Training",         desc: "Sessions tailored to your group." },
    { cid: "baby",          label: "Babysitting &amp; Childcare Services",           desc: "Vetted caretakers experienced with traveling families." },
    { cid: "party-popper",  label: "Celebration &amp; Event Coordination",           desc: "Support for birthdays, milestones, and special occasions." },
  ];

  // Group into rows of 2 columns
  const svcRows = [];
  for (let i = 0; i < EXTRA_SERVICES.length; i += 2) {
    svcRows.push(EXTRA_SERVICES.slice(i, i + 2));
  }

  const svcCardDiv = `border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;min-height:90px;box-sizing:border-box;`;
  const svcTitle   = `font-size:12px;font-weight:700;color:#1f2937;margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;`;
  const svcDesc    = `font-size:12px;color:#71717a;margin:0;font-family:Arial,Helvetica,sans-serif;line-height:1.5;`;

  const svcRowsHtml = svcRows.map((pair, rowIdx) => {
    const isLast = rowIdx === svcRows.length - 1;
    return `<tr>${pair.map((svc, colIdx) => `
      <td height="110" class="svc-col" valign="top" width="50%"
          style="padding:0 ${colIdx === 0 ? `8px ${isLast ? "0" : "12px"} 0` : `0 ${isLast ? "0" : "12px"} 8px`};">
        <div style="${svcCardDiv}">
          <p style="${svcTitle}">${icon14(svc.cid)}${svc.label}</p>
          <p style="${svcDesc}">${svc.desc}</p>
        </div>
      </td>`).join("")}
    </tr>`;
  }).join("");

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
        @media only screen and (max-width: 700px) {
          /* Full-width container — key fix for the narrow column issue */
          .wrap { width: 100% !important; max-width: 100% !important; }
          /* Remove outer vertical padding so email fills the screen edge-to-edge */
          .outer-td { padding: 0 !important; }
          /* Reduce horizontal padding on all section cells */
          .pad { padding-left: 16px !important; padding-right: 16px !important; }
          /* Trip bar: stack cells vertically */
          .trip-td { display: block !important; width: 100% !important; border-left: none !important; border-bottom: 1px solid #e5e7eb !important; padding: 12px 16px !important; box-sizing: border-box !important; }
          /* Card image: shorter on mobile */
          .card-img { height: 200px !important; }
          /* Card image td: no extra padding */
          .card-img-td { padding: 0 !important; line-height: 0 !important; font-size: 0 !important; }
          /* Services grid: single column */
          .svc-col { display: block !important; width: 100% !important; padding-right: 0 !important; padding-left: 0 !important; padding-bottom: 10px !important; }
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
        <td align="center" class="outer-td" style="padding:24px 0;">
    
          <!-- Inner 600px container -->
          <table cellpadding="0" cellspacing="0" border="0" role="presentation" class="wrap" style="${S.wrap}">
    
            <!-- ══ HEADER ══ -->
            <tr>
              <td class="pad" style="${S.hdCell}">
                <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                  <tr>
                    <td style="padding:0;text-align:center;">
                      ${headerBrandHtml}
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

            <!-- ══ SERVICES AVAILABLE FOR YOUR STAY ══ -->
            <tr>
              <td class="pad" style="background-color:#ffffff;padding:36px 40px 40px;border-top:1px solid #e5e7eb;">
                <p style="font-size:20px;font-weight:700;color:#09090b;text-align:center;margin:0 0 28px 0;font-family:Arial,Helvetica,sans-serif;">Services Available for Your Stay</p>
                <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top"><![endif]-->
                <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
                  ${svcRowsHtml}
                </table>
                <!--[if mso]></td></tr></table><![endif]-->
              </td>
            </tr>

            <!-- ══ FOOTER ══ -->
            <tr>
              <td class="pad" style="${S.ftCell}">
                <p style="${S.ftP}">Villa Net provides access to thousands of professionally managed vacation rentals around the world. Please contact your travel advisor for more information.</p>
                ${showAltCurrency ? `
                <p style="${S.ftP}">
                  * ${displayCurrency} amounts shown for reference only
                  (1 USD = ${altRate} ${displayCurrency}, ${RATE_DATE}).
                  Actual billing is always processed in USD.
                </p>` : ''}
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

function clampPct(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 0;
}

function safeJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

// ─── Local DB fees/taxes ──────────────────────────────────────────────────────

/**
 * Obtiene fees y taxes desde las tablas locales listing_fees / listing_taxes.
 * Retorna null si el listing no tiene registros (sin fees/taxes).
 */
async function getLocalFeesAndTaxes(listingId) {
  const [feesResult, taxesResult] = await Promise.all([
    pool.query(
      `SELECT fee_type, fee_name, value, is_percentage, multiplier, channel, target_fee
         FROM listing_fees
        WHERE listing_id = $1 AND is_enabled = true`,
      [listingId]
    ),
    pool.query(
      `SELECT tax_type, tax_name, rate, is_percentage, quantifier, applied_on
         FROM listing_taxes
        WHERE listing_id = $1 AND is_enabled = true`,
      [listingId]
    ),
  ]);

  return {
    fees: feesResult.rows,
    taxes: taxesResult.rows,
    hasFees: feesResult.rows.length > 0,
    hasTaxes: taxesResult.rows.length > 0,
  };
}

/**
 * Calcula el breakdown completo (base, cleaning, fees, taxes, total)
 * usando datos de la BD local. Requiere que ya tengamos el `base` (accommodation fare)
 * obtenido de Guesty via Open API.
 *
 * Lógica de fees:
 *   - is_percentage=true  → value es % sobre `base` (accommodation fare)
 *   - is_percentage=false → value es monto fijo en USD
 *   - multiplier: "per_night" multiplica por `nights`; otros se toman como monto único
 *
 * Lógica de taxes:
 *   - is_percentage=true  → rate es % sobre la base especificada en `applied_on`
 *     ("accommodation" → sobre base; "total" → sobre base+fees; default → sobre base)
 *   - is_percentage=false → rate es monto fijo
 */
function computeBreakdownFromLocal({ base, nights, localData, currency = "USD" }) {
  const { fees, taxes } = localData;

  let cleaning = 0;
  const feeBreakdown = [];

  for (const fee of fees) {
    const raw = Number(fee.value) || 0;
    const isPercent = Boolean(fee.is_percentage);
    const multiplier = String(fee.multiplier || "").toLowerCase();
    const feeName = fee.fee_name || fee.fee_type || "Fee";
    const feeType = String(fee.fee_type || "").toUpperCase();

    let amount;
    if (isPercent) {
      amount = base * (raw / 100);
    } else {
      amount = raw;
    }

    if (multiplier === "per_night") {
      amount = amount * nights;
    }

    amount = money2(amount);

    if (feeType.includes("CLEAN") || feeType === "CF") {
      cleaning += amount;
    } else {
      feeBreakdown.push({ title: feeName, amount, type: feeType || "FEE" });
    }
  }

  const feesTotal = money2(feeBreakdown.reduce((s, f) => s + f.amount, 0));

  // Taxes aplicados sobre la base o sobre subtotal según `applied_on`
  let taxesTotal = 0;
  for (const tax of taxes) {
    const raw = Number(tax.rate) || 0;
    const isPercent = Boolean(tax.is_percentage);
    const appliedOn = String(tax.applied_on || "accommodation").toLowerCase();

    let taxBase;
    if (appliedOn === "total") {
      taxBase = base + cleaning + feesTotal;
    } else {
      // "accommodation" u otros → sobre base
      taxBase = base;
    }

    const amount = isPercent ? money2(taxBase * (raw / 100)) : money2(raw);
    taxesTotal += amount;
  }

  taxesTotal = money2(taxesTotal);
  const total = money2(base + cleaning + feesTotal + taxesTotal);

  return { currency, base, cleaning, feeBreakdown, feesTotal, taxes: taxesTotal, total };
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

    // Solo Open API para el base (accommodation fare)
    const quote = await createOpenAPIQuote({
      listingId,
      checkIn,
      checkOut,
      guestsCount,
      source: "manual",
    });

    const guestyBreakdown = extractGuestyPriceBreakdown(quote);

    // ── Fees/taxes desde BD local ──────────────────────────────────────────
    let breakdown;
    let feesSource;
    try {
      const localData = await getLocalFeesAndTaxes(listingId);

      if (localData.hasFees || localData.hasTaxes) {
        console.log(`✅ [calculateQuote] listing=${listingId} → BD local (fees:${localData.fees.length}, taxes:${localData.taxes.length})`);
        breakdown = computeBreakdownFromLocal({
          base: guestyBreakdown.base,
          nights,
          localData,
          currency: guestyBreakdown.currency,
        });
        feesSource = "open-api+local-fees";
      } else {
        console.log(`⚠️  [calculateQuote] listing=${listingId} → sin registros locales, usando Guesty`);
        breakdown = guestyBreakdown;
        feesSource = "open-api";
      }
    } catch (dbErr) {
      console.warn(`⚠️  [calculateQuote] listing=${listingId} → error BD local, fallback a Guesty:`, dbErr.message);
      breakdown = guestyBreakdown;
      feesSource = "open-api";
    }
    // ──────────────────────────────────────────────────────────────────────

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
      source: feesSource,
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
  }

  if (!quoteData) {
    return null;
  }

  const nights = countStayNights(checkIn, checkOut);
  const guestyBreakdown = extractGuestyPriceBreakdown(quoteData);

  // ── Intentar fees/taxes desde BD local ────────────────────────────────────
  let breakdown;
  try {
    const localData = await getLocalFeesAndTaxes(listingId);

    if (localData.hasFees || localData.hasTaxes) {
      console.log(`✅ [fees/taxes] listing=${listingId} → BD local (fees:${localData.fees.length}, taxes:${localData.taxes.length})`);
      breakdown = computeBreakdownFromLocal({
        base: guestyBreakdown.base,
        nights,
        localData,
        currency: guestyBreakdown.currency,
      });
      sourceUsed += "+local-fees";
    } else {
      console.log(`⚠️  [fees/taxes] listing=${listingId} → sin registros locales, usando Guesty`);
      breakdown = guestyBreakdown;
    }
  } catch (dbErr) {
    console.warn(`⚠️  [fees/taxes] listing=${listingId} → error BD local, fallback a Guesty:`, dbErr.message);
    breakdown = guestyBreakdown;
  }

  return {
    currency: breakdown.currency,
    nights,
    base: breakdown.base,
    cleaning: breakdown.cleaning || 0,
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