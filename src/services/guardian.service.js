/**
 * guardian.service.js
 *
 * Verifica que las URLs de booking de cada villa habilitada en Villanet
 * respondan correctamente. Si detecta 404s, envía un email consolidado
 * al equipo con el reporte de villas rotas.
 *
 * Uso directo:   node src/services/guardian.service.js
 * Uso desde cron: importar runGuardian() y llamarla
 */

import { pool } from "../db.js";
import { sendEmail } from "./email.service.js";

// ─── Configuración ────────────────────────────────────────────────────────────

const GUARDIAN_CONFIG = {
  // Destinatarios del reporte de errores
  notificationRecipients: (process.env.GUARDIAN_RECIPIENTS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean),

  // Cuántas villas verificar en paralelo (evita saturar Guesty)
  concurrencyLimit: 5,

  // Timeout por request en ms (10 segundos)
  requestTimeoutMs: 10_000,

  // Solo reportar estos status codes como "rotos"
  // 0 = network error / timeout
  brokenStatuses: [404],

  // Si true, también loguea villas que respondieron OK
  verboseLogging: process.env.NODE_ENV === "development",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Construye la URL de booking para una villa.
 * Lógica espejo de buildGuestyUrl en quotesController.js
 */
function buildCheckUrl(guestyBookingDomain, listingId) {
  const raw = (guestyBookingDomain || "book.guesty.com").trim().replace(/\/+$/, "");
  const base = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://${raw}`;

  const url = new URL(base);
  url.pathname = url.host.endsWith("guestybookings.com")
    ? `/en/properties/${encodeURIComponent(listingId)}`
    : `/villas/${encodeURIComponent(listingId)}`;

  return url.toString();
}

/**
 * Guesty usa Next.js con SSR. Para propiedades que no existen, el servidor
 * devuelve HTTP 200 pero el HTML estático contiene señales detectables SIN
 * necesidad de ejecutar JavaScript.
 *
 * Señales encontradas comparando el HTML crudo de una villa inexistente vs. una válida:
 *
 * ❌ Villa no encontrada (soft-404):
 *    <title>Property page</title>          ← título genérico placeholder
 *    Sin <meta name="description"> real
 *    Sin <link rel="canonical">
 *    Sin og:title con datos reales
 *
 * ✅ Villa válida:
 *    <title>Nombre Real de la Villa | ...</title>
 *    <meta name="description" content="...descripción real...">
 *    <link rel="canonical" href="...">
 *    og:title con nombre de la villa
 *
 * El patrón más fiable y específico es el <title> genérico exacto.
 * Usamos también la ausencia de <link rel="canonical"> como señal de respaldo.
 */

/**
 * Patrones SSR que indican villa no encontrada en el HTML estático de Guesty.
 * Se buscan en los primeros ~8 KB del body (están en el <head>, muy al principio).
 */
const GUESTY_SOFT_404_SIGNALS = {
  // Título genérico exacto que Guesty renderiza cuando la propiedad no existe
  // Una villa real siempre tiene su nombre en el <title>
  genericTitle: /<title>Property page<\/title>/i,

  // Una villa válida siempre tiene canonical. Su ausencia es señal de error.
  // (usado solo como respaldo, no como señal primaria)
  noCanonical: /<link rel="canonical"/i, // invertido: si NO aparece → soft-404
};

/**
 * Detecta si el body HTML de Guesty indica una villa no encontrada (soft-404).
 * Guesty devuelve HTTP 200 con HTML estático que contiene señales identificables.
 *
 * @param {string} bodyText - Primeros bytes del HTML response
 * @returns {{ isBroken: boolean, reason: string }}
 */
function detectGuestySoft404(bodyText) {
  // Señal primaria: <title>Property page</title> exacto
  if (GUESTY_SOFT_404_SIGNALS.genericTitle.test(bodyText)) {
    return { isBroken: true, reason: "generic-title" };
  }

  // Señal de respaldo: si el <head> ya cerró y no había <link rel="canonical">
  // significa que Guesty no generó metadatos para esta villa.
  // Solo aplicamos esto si ya vimos el cierre del <head> en el fragmento leído.
  const headClosed = /<\/head>/i.test(bodyText);
  if (headClosed && !GUESTY_SOFT_404_SIGNALS.noCanonical.test(bodyText)) {
    return { isBroken: true, reason: "no-canonical-after-head-close" };
  }

  return { isBroken: false, reason: "ok" };
}

/**
 * Realiza un GET a la URL y verifica tanto el HTTP status code como
 * el contenido del body para detectar soft-404s de Guesty.
 *
 * Retorna:
 *   200  → OK, villa disponible
 *   404  → Rota (HTTP 404 real o soft-404 en el body)
 *   0    → Network error / timeout
 *   NNN  → Otro HTTP status code
 */
async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GUARDIAN_CONFIG.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "VillaNet-Guardian/1.0 (availability-monitor)",
        // Aceptar HTML para poder leer el body
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    // Si el HTTP status ya es un error real, retornarlo directamente
    if (!response.ok) {
      return response.status;
    }

    // HTTP 200 — leer solo los primeros ~8 KB del body.
    // El <title> de Guesty aparece en los primeros ~500 bytes del HTML,
    // y el </head> cierra antes del KB 8. No necesitamos leer más.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bodyChunk = "";
    let bytesRead = 0;
    const MAX_BYTES = 8_000;

    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyChunk += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;

      // Evaluar señales en cuanto tengamos suficiente contenido para decidir
      const { isBroken, reason } = detectGuestySoft404(bodyChunk);
      if (isBroken) {
        reader.cancel().catch(() => {}); // cancel silencioso
        console.warn(`🔍 Guesty soft-404 [${reason}]: ${url}`);
        return 404;
      }

      // Si ya pasó el </head> y no detectamos problemas → villa válida
      if (/<\/head>/i.test(bodyChunk)) {
        reader.cancel().catch(() => {});
        return 200;
      }
    }

    // Si llegamos aquí sin encontrar </head> (raro), ser conservadores y marcar OK
    return 200;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`⏱  Timeout checking: ${url}`);
    } else {
      console.warn(`🌐 Network error checking ${url}: ${err.message}`);
    }
    return 0; // 0 = unreachable
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ejecuta promesas con un límite de concurrencia.
 * Evita saturar el servidor de Guesty con decenas de requests simultáneos.
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = Promise.resolve().then(task).then((result) => {
      executing.delete(p);
      return result;
    });

    results.push(p);
    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Función principal. Puede llamarse desde el cron o manualmente.
 * Retorna un resumen del run.
 */
export async function runGuardian() {
  const startedAt = new Date();
  console.log(`\n🛡️  Guardian started at ${startedAt.toISOString()}`);

  // 1. Obtener todas las villas habilitadas
  let listings;
  try {
    const result = await pool.query(`
      SELECT listing_id, name, guesty_booking_domain
      FROM   listings
      WHERE  villanet_enabled = true
        AND  guesty_booking_domain IS NOT NULL
        AND  guesty_booking_domain <> ''
      ORDER  BY name ASC
    `);
    listings = result.rows;
    console.log(`📋 Found ${listings.length} enabled listings to check`);
  } catch (dbErr) {
    console.error("❌ Guardian: failed to query listings:", dbErr.message);
    throw dbErr;
  }

  if (listings.length === 0) {
    console.log("✅ No listings to check. Guardian done.");
    return { checked: 0, broken: 0, errors: [] };
  }

  // 2. Verificar cada URL con control de concurrencia
  const checkResults = await runWithConcurrency(
    listings.map((listing) => async () => {
      const url = buildCheckUrl(listing.guesty_booking_domain, listing.listing_id);
      const status = await checkUrl(url);

      if (GUARDIAN_CONFIG.verboseLogging) {
        const icon = status === 200 ? "✅" : status === 0 ? "⚠️ " : "❌";
        console.log(`${icon} [${status}] ${listing.name} → ${url}`);
      }

      return { ...listing, url, status };
    }),
    GUARDIAN_CONFIG.concurrencyLimit
  );

  // 3. Separar villas rotas de las OK
  const broken = checkResults.filter((r) =>
    GUARDIAN_CONFIG.brokenStatuses.includes(r.status)
  );
  const networkErrors = checkResults.filter((r) => r.status === 0);
  const ok = checkResults.filter(
    (r) => !GUARDIAN_CONFIG.brokenStatuses.includes(r.status) && r.status !== 0
  );

  console.log(`\n📊 Results: ${ok.length} OK | ${broken.length} broken (404) | ${networkErrors.length} unreachable`);

  // 4. Persistir resultados en la DB (trazabilidad)
  await persistCheckResults(checkResults);

  // 5. Enviar notificación si hay villas rotas
  if (broken.length > 0) {
    await sendGuardianReport({ broken, networkErrors, total: listings.length, startedAt });
  } else {
    console.log("✅ No broken listings found. No email sent.");
  }

  const summary = {
    checkedAt: startedAt.toISOString(),
    total: listings.length,
    ok: ok.length,
    broken: broken.length,
    networkErrors: networkErrors.length,
    brokenListings: broken.map((b) => ({ id: b.listing_id, name: b.name, url: b.url })),
  };

  console.log(`\n🛡️  Guardian finished in ${Date.now() - startedAt.getTime()}ms\n`);
  return summary;
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

async function persistCheckResults(results) {
  if (results.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const r of results) {
      await client.query(
        `UPDATE listings
         SET    last_url_check_status = $1,
                last_url_check_at     = NOW()
         WHERE  listing_id = $2`,
        [r.status, r.listing_id]
      );
    }

    await client.query("COMMIT");
    console.log(`💾 Persisted check results for ${results.length} listings`);
  } catch (err) {
    await client.query("ROLLBACK");
    // No lanzamos el error — la persistencia es opcional, no debe matar el guardian
    console.error("⚠️  Guardian: failed to persist results (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendGuardianReport({ broken, networkErrors, total, startedAt }) {
  const recipients = GUARDIAN_CONFIG.notificationRecipients;

  if (recipients.length === 0) {
    console.warn("⚠️  Guardian: no notification recipients configured. Skipping email.");
    return;
  }

  const html = buildReportHtml({ broken, networkErrors, total, startedAt });
  const subject = `🛡️ Guardian Alert: ${broken.length} villa${broken.length !== 1 ? "s" : ""} with broken booking links`;

  try {
    await sendEmail({
      to: recipients.join(", "),
      subject,
      html,
      // Gmail App Password requiere que 'from' sea el mismo SMTP_USER autenticado.
      // Sobreescribimos el SMTP_FROM del .env para este email en particular.
      from: `"VillaNet Guardian" <${process.env.SMTP_USER}>`,
    });
    console.log(`📨 Guardian report sent to: ${recipients.join(", ")}`);
  } catch (emailErr) {
    // No lanzamos — si el email falla, el guardian igual termina limpiamente
    console.error("❌ Guardian: failed to send report email:", emailErr.message);
  }
}

function buildReportHtml({ broken, networkErrors, total, startedAt }) {
  const dateStr = startedAt.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "America/New_York",
  });

  const brokenRows = broken
    .map(
      (v) => `
      <tr>
        <td class="data-td id-col" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:11px;color:#71717a;font-family:monospace;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v.listing_id}</td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#111827;">${v.name}</td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">
          <a class="url-link" href="${v.url}" style="color:#dc2626;font-size:12px;text-decoration:underline;white-space:nowrap;">Ver enlace</a>
        </td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">
          <span class="status-pill" style="background:#fee2e2;color:#dc2626;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;">404</span>
        </td>
      </tr>`
    )
    .join("");

  const networkRows =
    networkErrors.length > 0
      ? networkErrors
          .map(
            (v) => `
      <tr>
        <td class="data-td id-col" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:11px;color:#71717a;font-family:monospace;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v.listing_id}</td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#111827;">${v.name}</td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">
          <a class="url-link" href="${v.url}" style="color:#d97706;font-size:12px;text-decoration:underline;white-space:nowrap;">Ver enlace</a>
        </td>
        <td class="data-td" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">
          <span class="status-pill" style="background:#fef3c7;color:#d97706;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;">TIMEOUT</span>
        </td>
      </tr>`
          )
          .join("")
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    @media only screen and (max-width: 600px) {
      .main-wrapper { padding: 16px 8px !important; }
      .header-box { padding: 24px 16px !important; }
      .content-box { padding: 16px !important; }
      .stat-td { padding: 12px 2px !important; }
      .stat-num { font-size: 20px !important; }
      .stat-label { font-size: 8px !important; }
      .data-th { padding: 8px 4px !important; font-size: 10px !important; }
      .data-td { padding: 10px 4px !important; font-size: 11px !important; }
      .id-col { max-width: 60px !important; font-size: 10px !important; }
      .url-link { font-size: 11px !important; }
      .status-pill { font-size: 10px !important; padding: 2px 6px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div class="main-wrapper" style="max-width:700px;margin:0 auto;padding:32px 16px;">

  <div class="header-box" style="background:#09090b;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
    <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#71717a;">VILLANET</p>
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;">🛡️ Guardian Alert</h1>
  </div>

  <div class="content-box" style="background:#ffffff;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:20px 32px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td class="stat-td" style="text-align:center;padding:12px;border-right:1px solid #f0f0f0;width:25%;">
          <p class="stat-num" style="margin:0;font-size:28px;font-weight:700;color:#111827;">${total}</p>
          <p class="stat-label" style="margin:4px 0 0;font-size:11px;color:#71717a;text-transform:uppercase;">Checked</p>
        </td>
        <td class="stat-td" style="text-align:center;padding:12px;border-right:1px solid #f0f0f0;width:25%;">
          <p class="stat-num" style="margin:0;font-size:28px;font-weight:700;color:#16a34a;">${total - broken.length - networkErrors.length}</p>
          <p class="stat-label" style="margin:4px 0 0;font-size:11px;color:#71717a;text-transform:uppercase;">OK</p>
        </td>
        <td class="stat-td" style="text-align:center;padding:12px;border-right:1px solid #f0f0f0;width:25%;">
          <p class="stat-num" style="margin:0;font-size:28px;font-weight:700;color:#dc2626;">${broken.length}</p>
          <p class="stat-label" style="margin:4px 0 0;font-size:11px;color:#71717a;text-transform:uppercase;">404</p>
        </td>
        <td class="stat-td" style="text-align:center;padding:12px;width:25%;">
          <p class="stat-num" style="margin:0;font-size:28px;font-weight:700;color:#d97706;">${networkErrors.length}</p>
          <p class="stat-label" style="margin:4px 0 0;font-size:11px;color:#71717a;text-transform:uppercase;">Timeout</p>
        </td>
      </tr>
    </table>
  </div>

  <div class="content-box" style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:0 32px 24px;">
    <div style="overflow-x:hidden;">
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;table-layout: fixed;">
        <thead>
          <tr style="background:#f9fafb;">
            <th class="data-th" style="width:70px;padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#52525b;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">ID</th>
            <th class="data-th" style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#52525b;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Villa</th>
            <th class="data-th" style="width:80px;padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#52525b;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">URL</th>
            <th class="data-th" style="width:70px;padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:#52525b;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${brokenRows}
          ${networkRows}
        </tbody>
      </table>
    </div>
  </div>

   <!-- What to do -->
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:20px 24px;margin-top:16px;">
    <h3 style="margin:0 0 10px;font-size:14px;font-weight:600;color:#92400e;">⚠️ Action required</h3>
    <ol style="margin:0;padding-left:18px;color:#78350f;font-size:13px;line-height:1.8;">
      <li>Log in to <strong>Guesty</strong> and search for each listing by ID.</li>
      <li>Verify that the listing is <strong>published</strong> and the booking page is enabled.</li>
      <li>Check that the <strong>guesty_booking_domain</strong> in VillaNet's DB matches the property's actual booking domain.</li>
      <li>Once fixed, the next Guardian run will confirm the issue is resolved.</li>
    </ol>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:24px 0 8px;">
    <p style="margin:0;font-size:12px;color:#a1a1aa;">
      VillaNet Guardian · Automated check run on ${dateStr} (EST)<br>
      This report is sent automatically every 48 hours.
    </p>
  </div>

</div>
</body>
</html>`;
}