/**
 * Unique Guesty booking-URL builder for Villa Net.
 * Used by quote emails and the guardian URL checker.
 */

export const VILLANET_DEFAULT_BOOKING_DOMAIN =
  "https://villanet.guestybookings.com";

/** Explicit denylist for known-dead / legacy Guesty hosts. */
const INVALID_HOSTS = new Set(["book.guesty.com"]);

/**
 * Returns a sanitized booking-engine base URL, or null if invalid.
 * Does not apply the Villa Net fallback — use resolveGuestyBookingDomain for that.
 *
 * Invalid: empty/null, book.guesty.com (+ /villas), any host not ending in guestybookings.com.
 */
export function sanitizeGuestyBookingDomain(domainOrUrl) {
  if (domainOrUrl == null) return null;
  if (typeof domainOrUrl !== "string") return null;

  const raw = domainOrUrl.trim().replace(/\/+$/, "");
  if (!raw) return null;

  const withProto =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `https://${raw}`;

  let url;
  try {
    url = new URL(withProto);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (INVALID_HOSTS.has(host)) return null;
  if (!host.endsWith("guestybookings.com")) return null;

  return `https://${host}`;
}

/**
 * First sanitizable candidate wins; otherwise Villa Net default.
 * Prefer listing domain over quote-item / client-supplied domain.
 */
export function resolveGuestyBookingDomain(...candidates) {
  for (const candidate of candidates) {
    const sanitized = sanitizeGuestyBookingDomain(candidate);
    if (sanitized) return sanitized;
  }
  return VILLANET_DEFAULT_BOOKING_DOMAIN;
}

/**
 * Build a Guesty Booking Engine property URL.
 *
 * @param {object} opts
 * @param {string} [opts.bookingDomain] - raw or already-resolved domain
 * @param {string} [opts.domainOrUrl] - alias of bookingDomain (legacy call sites)
 * @param {string} opts.listingId | opts.propertyId
 * @param {string} [opts.checkIn] | [opts.checkInYmd]
 * @param {string} [opts.checkOut] | [opts.checkOutYmd]
 * @param {number|string} [opts.guests]
 */
export function buildGuestyUrl({
  bookingDomain,
  domainOrUrl,
  listingId,
  propertyId,
  checkIn,
  checkOut,
  checkInYmd,
  checkOutYmd,
  guests,
} = {}) {
  const id = listingId ?? propertyId;
  if (id == null || String(id).trim() === "") {
    throw new Error("buildGuestyUrl: listingId/propertyId is required");
  }

  const base = resolveGuestyBookingDomain(bookingDomain ?? domainOrUrl);
  const url = new URL(base);
  url.pathname = `/en/properties/${encodeURIComponent(String(id))}`;

  const g = Number(guests);
  const occupancy = Number.isFinite(g) && g > 0 ? g : 1;
  url.searchParams.set("minOccupancy", String(occupancy));
  url.searchParams.set("adults", String(occupancy));

  const inYmd = checkInYmd ?? checkIn;
  const outYmd = checkOutYmd ?? checkOut;
  if (inYmd) url.searchParams.set("checkIn", inYmd);
  if (outYmd) url.searchParams.set("checkOut", outYmd);

  return url.toString();
}
