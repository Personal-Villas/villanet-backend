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
import { createOpenAPIQuote } from "../services/openApiQuote.service.js";
import { extractGuestyPriceBreakdown } from "../services/extractGuestyPriceBreakdown.js";


// ─── Date helpers ─────────────────────────────────────────────────────────────

function countStayNights(from, to) {
  const start = new Date(from);
  const end   = new Date(to);
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
  if (!domainOrUrl || typeof domainOrUrl !== "string") return "https://book.guesty.com";
  const raw = domainOrUrl.trim().replace(/\/+$/, "");
  const withProto = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  return withProto.replace(/\/+$/, "");
}

function buildGuestyUrl({ domainOrUrl, listingId, checkInYmd, checkOutYmd, guests }) {
  const base = normalizeBaseUrl(domainOrUrl);
  const url  = new URL(base);
  const id   = encodeURIComponent(String(listingId));

  url.pathname = url.host.endsWith("guestybookings.com")
    ? `/en/properties/${id}`
    : `/villas/${id}`;

  const g = Number(guests);
  url.searchParams.set("minOccupancy", String(Number.isFinite(g) && g > 0 ? g : 1));
  if (checkInYmd)  url.searchParams.set("checkIn",  checkInYmd);
  if (checkOutYmd) url.searchParams.set("checkOut", checkOutYmd);
  return url.toString();
}

// ─── Controllers ──────────────────────────────────────────────────────────────

export async function quotesAvailabilityCheck(req, res) {
  try {
    const checkIn  = ymd10(req.body?.checkIn);
    const checkOut = ymd10(req.body?.checkOut);
    const strict   = Boolean(req.body?.strict);
    const items    = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!checkIn || !checkOut)
      return res.status(400).json({ ok: false, error: "checkIn/checkOut requeridos (YYYY-MM-DD)" });
    if (new Date(checkIn) >= new Date(checkOut))
      return res.status(400).json({ ok: false, error: "checkOut debe ser posterior a checkIn" });
    if (!items.length)
      return res.status(400).json({ ok: false, error: "items[] requerido" });

    const ids = [...new Set(items.map((x) => String(x?.id || x?.listingId || "").trim()).filter(Boolean))];
    if (!ids.length)
      return res.status(400).json({ ok: false, error: "No hay listing IDs válidos" });

    const nights = countStayNights(checkIn, checkOut);
    const quick  = await getAvailabilityFor(ids, checkIn, checkOut);
    const byId   = new Map(quick.map((r) => [String(r.listing_id), r]));

    const results = ids.map((id) => {
      const r = byId.get(String(id));
      if (!r) return { listingId: id, available: null, reason: "no-result" };

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
        meta: { nightlyFrom: r.nightlyFrom ?? null, hasRestrictions: Boolean(r.hasRestrictions), daysCount: r.daysCount ?? null, nights },
      };
    });

    if (strict) {
      const limit      = pLimit(2);
      const strictIds  = results.filter((x) => x.available === true).map((x) => x.listingId);
      const strictPairs = await Promise.all(
        strictIds.map((id) =>
          limit(async () => {
            try { return [id, await checkStrictAvailability(id, checkIn, checkOut)]; }
            catch { return [id, null]; }
          })
        )
      );
      const strictMap = new Map(strictPairs);
      for (const r of results) {
        if (r.available === true && strictMap.has(r.listingId)) {
          const ok = strictMap.get(r.listingId);
          if (ok === false) { r.available = false; r.reason = "restricted-cta-ctd"; }
          else if (ok === null) { r.available = null; r.reason = "strict-check-failed"; }
        }
      }
    }

    return res.json({ ok: true, results });
  } catch (e) {
    console.error("❌ /quotes/availability-check error:", e);
    return res.status(500).json({ ok: false, error: "Error interno", details: e.message });
  }
}

export async function createQuote(req, res) {
  const client = await pool.connect();
  try {
    const { guestFirstName, guestLastName, travelAdvisorEmail, guestEmail, checkIn, checkOut, guests, items } = req.body;

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "El array 'items' es requerido y debe contener al menos una propiedad" });

    const invalidItems = items.filter((item) => !item.id);
    if (invalidItems.length > 0)
      return res.status(400).json({ error: "Todos los items deben tener un ID válido", invalidItems });

    await client.query("BEGIN");

    const quoteQuery = await client.query(
      `INSERT INTO quotes (created_by_user_id, guest_first_name, guest_last_name, travel_advisor_email, guest_email, check_in, check_out, guests, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft') RETURNING id, created_at`,
      [req.user?.id || null, guestFirstName?.trim() || null, guestLastName?.trim() || null,
       travelAdvisorEmail?.trim() || null, guestEmail?.trim() || null,
       checkIn || null, checkOut || null, guests || null]
    );
    const quoteId = quoteQuery.rows[0].id;

    for (const item of items) {
      if (!item.id) throw new Error(`Item sin ID: ${JSON.stringify(item)}`);
      if (!item.guestyBookingDomain) throw new Error(`Falta guestyBookingDomain para la propiedad ${item.id}`);

      await client.query(
        `INSERT INTO quote_items (quote_id, listing_id, listing_name, listing_location, bedrooms, bathrooms, price_usd, image_url, guesty_booking_domain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (quote_id, listing_id) DO NOTHING`,
        [quoteId, item.id, item.name || null, item.location || null, item.bedrooms ?? null,
         item.bathrooms ?? null, item.priceUSD ? Number(item.priceUSD) : null, item.imageUrl || null, item.guestyBookingDomain]
      );
    }

    await client.query(
      `INSERT INTO quote_history (quote_id, event_type, actor_user_id, payload) VALUES ($1, 'CREATED', $2, $3)`,
      [quoteId, req.user?.id || null, JSON.stringify({ itemsCount: items.length, guestFirstName, guestLastName, travelAdvisorEmail, guestEmail, checkIn, checkOut })]
    );

    await client.query("COMMIT");
    return res.status(201).json({ success: true, quoteId, message: `Quote creado con ${items.length} propiedades` });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error creando quote:", error);
    return res.status(500).json({ error: "Error interno al crear el quote", details: process.env.NODE_ENV === "development" ? error.message : undefined });
  } finally {
    client.release();
  }
}

export async function getQuoteDetails(req, res) {
  try {
    const { id } = req.params;
    const quoteResult = await pool.query(
      `SELECT q.*, u.email as created_by_email, u.full_name as created_by_name
       FROM quotes q LEFT JOIN users u ON q.created_by_user_id = u.id WHERE q.id = $1`, [id]
    );
    if (quoteResult.rows.length === 0) return res.status(404).json({ error: "Quote no encontrado" });

    const itemsResult   = await pool.query(`SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY created_at`, [id]);
    const historyResult = await pool.query(`SELECT * FROM quote_history WHERE quote_id = $1 ORDER BY created_at DESC`, [id]);

    return res.json({ quote: quoteResult.rows[0], items: itemsResult.rows, history: historyResult.rows });
  } catch (error) {
    console.error("❌ Error obteniendo quote:", error);
    return res.status(500).json({ error: "Error interno" });
  }
}

export async function sendQuoteEmail(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { guestFirstName, guestLastName, travelAdvisorEmail, guestEmail, checkIn, checkOut, guests, items } = req.body;
    const userId = req.user?.id;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!guestFirstName?.trim())      return res.status(400).json({ ok: false, error: "Guest first name is required" });
    if (!guestLastName?.trim())       return res.status(400).json({ ok: false, error: "Guest last name is required" });
    if (!travelAdvisorEmail?.trim())  return res.status(400).json({ ok: false, error: "Travel advisor email is required" });
    if (!emailRegex.test(travelAdvisorEmail)) return res.status(400).json({ ok: false, error: "Invalid travel advisor email format" });
    if (guestEmail && !emailRegex.test(guestEmail)) return res.status(400).json({ ok: false, error: "Invalid guest email format" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "Items array is required" });

    await client.query("BEGIN");
    const updateResult = await client.query(
      `UPDATE quotes SET guest_first_name=$2, guest_last_name=$3, travel_advisor_email=$4, guest_email=$5,
       check_in=$6, check_out=$7, guests=$8, updated_at=NOW() WHERE id=$1 AND status='draft' RETURNING *`,
      [id, guestFirstName.trim(), guestLastName.trim(), travelAdvisorEmail.trim(), guestEmail?.trim() || null,
       checkIn || null, checkOut || null, guests || null]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Quote no encontrado o ya enviado" });
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
      return res.status(400).json({ ok: false, error: "El quote no tiene propiedades" });
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
          listingId:   item.listing_id,
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
    
    const advisorHtml = await generateQuoteEmailHtml(
      { ...quote, recipient_type: "advisor" }, itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName
    );
    
    await sendEmail({
      to: quote.travel_advisor_email,
      subject: `Your Quote for ${quote.guest_first_name} ${quote.guest_last_name}`,
      html: advisorHtml,
    });

    if (quote.guest_email?.trim()) {
      const guestHtml = await generateQuoteEmailHtml(
        { ...quote, recipient_type: "guest" }, itemsWithFullData, nights, checkInYmd, checkOutYmd, pmLogoUrl, pmName
      );
      await sendEmail({
        to: quote.guest_email,
        subject: `Your Curated Villa Options — ${quote.guest_first_name} ${quote.guest_last_name}`,
        html: guestHtml,
      });
    }

    await client.query(`UPDATE quotes SET status='sent', updated_at=NOW() WHERE id=$1`, [id]);
    
    await client.query(
      `INSERT INTO quote_history (quote_id, event_type, actor_user_id, payload) VALUES ($1, 'SENT', $2, $3)`,
      [id, userId || null, JSON.stringify({
        guestFirstName: quote.guest_first_name, guestLastName: quote.guest_last_name,
        travelAdvisorEmail: quote.travel_advisor_email, guestEmailSent: !!quote.guest_email,
        checkIn: checkInYmd, checkOut: checkOutYmd, guests: quote.guests, itemsCount: itemsWithFullData.length,
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
    return res.json({
      success: true,
      message: guestEmail
        ? `Emails sent to ${quote.travel_advisor_email} and ${quote.guest_email}`
        : `Email sent to ${quote.travel_advisor_email}`,
      quoteId: id,
      emailsSent: { advisor: quote.travel_advisor_email, guest: quote.guest_email || null },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error enviando email de quote:", error);
    return res.status(500).json({ ok: false, error: "Error interno al enviar el email",
      details: process.env.NODE_ENV === "development" ? error.message : undefined });
  } finally {
    client.release();
  }
}

// ─── Email template ───────────────────────────────────────────────────────────

export async function generateQuoteEmailHtml(quote, items, nights, checkInYmd, checkOutYmd, pmLogoUrl = null, pmName = "villanet") {
  const formatDate = (dateStr) => {
    if (!dateStr) return "Flexible Dates";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  };

  const fmt = (amount) => {
    if (!amount && amount !== 0) return "Contact for pricing";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(amount);
  };

  const safeNights  = nights || 1;
  const isGuest     = quote.recipient_type === "guest";
  const greeting    = isGuest ? `Hello, ${quote.guest_first_name}` : `Hello, Travel Advisor`;
  const intro       = isGuest
    ? `Here are your curated villa options, handpicked based on your preferences.`
    : `Here is the quote prepared for your client, <strong>${quote.guest_first_name} ${quote.guest_last_name}</strong>.`;

  // PNG icons — email-safe (no SVG)
  const iconPin  = `<img src="https://img.icons8.com/?size=100&id=3723&format=png&color=71717a"   width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;
  const iconBed  = `<img src="https://img.icons8.com/?size=100&id=7546&format=png&color=71717a"   width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;
  const iconBath = `<img src="https://img.icons8.com/?size=100&id=11485&format=png&color=71717a"  width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;
  const iconCal  = `<img src="https://img.icons8.com/?size=100&id=23&format=png&color=71717a"     width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;
  const iconNight= `<img src="https://img.icons8.com/?size=100&id=660&format=png&color=71717a"    width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;
  const iconGuest= `<img src="https://img.icons8.com/?size=100&id=fEZo4zNy3Mqa&format=png&color=71717a" width="13" height="13" style="vertical-align:middle;margin-right:5px;" alt="">`;

  const logo = pmLogoUrl
    ? `<img src="${pmLogoUrl}" alt="${pmName}" style="max-height:44px;max-width:180px;object-fit:contain;">`
    : `<span style="font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#09090b;">VILLANET</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:Inter,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#09090b;background:#f4f4f5;}
    .wrap{max-width:600px;margin:0 auto;}
    /* header */
    .hd{background:#fff;padding:36px 40px 28px;text-align:center;border-bottom:1px solid #e5e7eb;}
    .hd-label{font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin-bottom:20px;}
    .hd h1{font-size:26px;font-weight:600;color:#09090b;line-height:1.2;margin:16px 0 10px;}
    .hd p{font-size:14px;color:#52525b;line-height:1.6;}
    /* trip info bar */
    .trip{background:#fff;margin:0;padding:20px 40px;border-bottom:1px solid #e5e7eb;}
    .trip-grid{display:table;width:100%;border-collapse:collapse;}
    .trip-cell{display:table-cell;width:25%;padding:10px 12px;vertical-align:middle;font-size:13px;}
    .trip-cell + .trip-cell{border-left:1px solid #e5e7eb;}
    .trip-cell .tc-label{font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#71717a;margin-bottom:3px;}
    .trip-cell .tc-val{font-weight:600;color:#09090b;font-size:13px;}
    /* cards */
    .content{padding:24px 40px 32px;}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:20px;}
    .card-img{width:100%;height:220px;object-fit:cover;display:block;}
    .card-body{padding:22px 24px 24px;}
    .card-title{font-size:18px;font-weight:600;color:#09090b;margin-bottom:12px;line-height:1.3;}
    .card-meta{margin-bottom:16px;}
    .card-meta p{font-size:13px;color:#71717a;margin-bottom:5px;line-height:1.4;}
    /* breakdown */
    .bd{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin-bottom:18px;}
    .bd-row{display:table;width:100%;padding:6px 0;}
    .bd-row+.bd-row{border-top:1px solid #f0f0f0;}
    .bd-label{display:table-cell;font-size:13px;color:#52525b;vertical-align:middle;}
    .bd-val{display:table-cell;font-size:13px;font-weight:600;color:#09090b;text-align:right;vertical-align:middle;}
    .bd-total .bd-label{font-weight:600;color:#09090b;font-size:14px;padding-top:10px;}
    .bd-total .bd-val{font-size:16px;font-weight:700;color:#09090b;padding-top:10px;}
    .bd-total{border-top:2px solid #e5e7eb !important;margin-top:4px;}
    .disclaimer{font-size:11px;color:#a1a1aa;margin-top:10px;line-height:1.5;padding:0 2px;}
    /* CTA button */
    .btn-wrap{text-align:center;}
    .btn{display:inline-block;background:#09090b;color:#ffffff !important;text-decoration:none;
         font-size:13px;font-weight:600;letter-spacing:0.02em;padding:13px 28px;
         border-radius:8px;width:100%;text-align:center;}
    /* footer */
    .ft{background:#fafafa;padding:28px 40px;text-align:center;border-top:1px solid #e5e7eb;}
    .ft p{font-size:12px;color:#71717a;margin:4px 0;line-height:1.6;}
    @media(max-width:600px){
      .hd,.trip,.content,.ft{padding-left:20px;padding-right:20px;}
      .trip-cell{display:block;width:100%;border-left:none !important;border-bottom:1px solid #e5e7eb;padding:8px 0;}
      .card-img{height:180px;}
    }
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="hd">
    <div class="hd-label">${logo}</div>
    <h1>Your Curated Villa Options</h1>
    <p>${greeting}! ${intro}</p>
  </div>

  <!-- Trip summary bar -->
  <div class="trip">
    <div class="trip-grid">
      <div class="trip-cell">
        <div class="tc-label">${iconCal} Check-in</div>
        <div class="tc-val">${formatDate(checkInYmd)}</div>
      </div>
      <div class="trip-cell">
        <div class="tc-label">${iconCal} Check-out</div>
        <div class="tc-val">${formatDate(checkOutYmd)}</div>
      </div>
      <div class="trip-cell">
        <div class="tc-label">${iconNight} Nights</div>
        <div class="tc-val">${safeNights}</div>
      </div>
      ${quote.guests ? `<div class="trip-cell"><div class="tc-label">${iconGuest} Guests</div><div class="tc-val">${quote.guests}</div></div>` : ""}
    </div>
  </div>

  <!-- Villa cards -->
  <div class="content">
    ${items.map((item) => {
      const b = item.breakdown;
      if (!b) return "";

      // Generar filas de fees individuales
      const feeRows = (() => {
        if (b.feeBreakdown?.length > 0) {
          return b.feeBreakdown.filter(f => f.amount > 0).map(f => `
            <div class="bd-row">
              <span class="bd-label">${f.title}</span>
              <span class="bd-val">${fmt(f.amount)}</span>
            </div>`).join("");
        }
        if (b.otherFees > 0) {
          return `<div class="bd-row"><span class="bd-label">Other Fees</span><span class="bd-val">${fmt(b.otherFees)}</span></div>`;
        }
        return "";
      })();

      // Fila de Fees total (si hay fees)
      const feesTotalRow = (Number(b.feesTotal) > 0) ? `
      <div class="bd-row">
        <span class="bd-label">Fees</span>
        <span class="bd-val">${fmt(b.feesTotal)}</span>
      </div>
    ` : "";

      return `
    <div class="card">
      ${item.image_url ? `<img src="${item.image_url}" class="card-img" alt="${item.listing_name || "Villa"}">` : ""}
      <div class="card-body">
        <div class="card-title">${item.listing_name || "Luxury Villa"}</div>
        <div class="card-meta">
          <p>${iconPin}${item.listing_location || ""}</p>
          <p>${iconBed}${item.bedrooms} Bedrooms &nbsp;·&nbsp; ${iconBath}${item.bathrooms} Bathrooms</p>
        </div>

        <div class="bd">
          <div class="bd-row">
            <span class="bd-label">Base Rate (${safeNights} night${safeNights !== 1 ? "s" : ""})</span>
            <span class="bd-val">${fmt(b.base)}</span>
          </div>
          ${b.cleaning > 0 ? `<div class="bd-row"><span class="bd-label">Cleaning Fee</span><span class="bd-val">${fmt(b.cleaning)}</span></div>` : ""}
          ${feesTotalRow}
          ${feeRows}
          ${b.taxes > 0 ? `<div class="bd-row"><span class="bd-label">Taxes</span><span class="bd-val">${fmt(b.taxes)}</span></div>` : ""}
          
          <!-- ✅ Total EXACTO del checkout (sin comisión) -->
          <div class="bd-row bd-total">
            <span class="bd-label">Total</span>
            <span class="bd-val">${fmt(b.total)}</span>
          </div>
        </div>

        <div class="btn-wrap">
          <a href="${item.guestyUrl}" class="btn">View Availability &amp; Book &rarr;</a>
        </div>
      </div>
    </div>`;
    }).join("")}
  </div>

  <!-- Footer -->
  <div class="ft">
    <p>Book with Confidence. Earn with Trust.</p>
    <p>This quote was generated by VillaNet — connecting you with the world's most vetted villas.</p>
    ${!isGuest ? `<p>Questions? Reply to this email or contact your client directly.</p>` : `<p>Questions? Contact your travel advisor directly.</p>`}
  </div>

</div>
<!-- anti-preheader filler -->
<div style="display:none;max-height:0;overflow:hidden;">${crypto.randomBytes(8).toString("hex")}</div>
</body>
</html>`;
}

// ─── Additional controllers ───────────────────────────────────────────────────

export async function checkQuotesAvailability(req, res) {
  try {
    const { checkIn, checkOut, guests, items } = req.body || {};
    if (!checkIn || !checkOut) return res.status(400).json({ ok: false, error: "checkIn y checkOut son requeridos" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "items es requerido (array)" });

    const results = await checkGuestyAvailabilityBatch({
      checkIn, checkOut, guests: guests || null,
      items: items.map((it) => ({ id: String(it.id), guestyBookingDomain: it.guestyBookingDomain || null })),
    });
    return res.json({ ok: true, results });
  } catch (e) {
    console.error("❌ availability-check error:", e);
    return res.status(500).json({ ok: false, error: "Error interno", details: e.message });
  }
}


// ─── Helpers ─────────────────────────────────────────────────────────────────


function isYmd(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function money2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function sumByPred(items, pred) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    if (!it || !pred(it)) continue;
    const amt = Number(it.amount ?? it.total ?? it.value ?? it.price ?? it.netAmount ?? it.grossAmount ?? it.gross);
    if (Number.isFinite(amt)) total += amt;
  }
  return total;
}

function safeJson(x) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }


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
      source: "booking-engine",
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
      message: "No se pudo obtener cotización de Guesty",
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