import axios from 'axios';
import { cache } from '../cache.js'; 
const BASE_URL = 'https://open-api.guesty.com/v1';

function getNextCursor(data) {
  if (data?.next) {
    try { return new URL(data.next).searchParams.get('cursor'); }
    catch { return data.next; }
  }
  if (data?.pagination?.nextCursor) return data.pagination.nextCursor;
  if (data?.cursor?.next) return data.cursor.next;
  if (data?.meta?.next) return data.meta.next;
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createClient(guestyToken) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${guestyToken}` },
    timeout: 30000
  });
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function handleRateLimit(e, attempt) {
  const retryAfter = getHeader(e?.response?.headers, 'retry-after');
  let waitTimeMs = 400 * attempt;
  if (retryAfter) {
    const waitSeconds = parseInt(retryAfter, 10);
    if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
      waitTimeMs = waitSeconds * 1000;
      console.warn(`[Guesty] 429: Retry-After ${waitSeconds}s`);
    }
  } else {
    console.warn(`[Guesty] 429: backoff ${waitTimeMs/1000}s (attempt ${attempt})`);
  }
  return waitTimeMs;
}

export function mapListingMinimal(l) {
  const id = l?._id || l?.id || null;

  const rawName = l?.nickname || l?.title || l?.name || l?.internalName || null;
  const name = (typeof rawName === 'string' && rawName.trim())
    ? rawName.trim()
    : (id ? `Listing ${id}` : 'Listing');

  const bedrooms =
    l?.bedrooms ??
    l?.roomCount ??
    l?.space?.bedrooms ??
    (Array.isArray(l?.listingRooms) ? l.listingRooms.length : null) ?? null;

  const bathrooms =
    l?.bathrooms ??
    l?.bathroomsNumber ??
    l?.space?.bathrooms ??
    l?.defaultBathrooms ??
    l?.accommodates?.bathrooms ?? null;

  let priceUSD = null;
  if (l?.prices?.basePrice && l?.prices?.currency === 'USD') {
    priceUSD = Math.round(Number(l.prices.basePrice) * 100) / 100;
  } else if (l?.price?.basePriceUSD) {
    priceUSD = Math.round(Number(l.price.basePriceUSD) * 100) / 100;
  } else if (l?.pricingSettings?.basePrice && l?.pricingSettings?.currency === 'USD') {
    priceUSD = Math.round(Number(l.pricingSettings.basePrice) * 100) / 100;
  }

  const location =
    l?.address?.full ||
    [l?.address?.line1, l?.address?.city, l?.address?.country].filter(Boolean).join(', ') ||
    null;

  let heroImage = null;
  if (l?.picture) {
    heroImage = l.picture.large || l.picture.original || l.picture.regular || l.picture.thumbnail || null;
  }
  if (!heroImage && Array.isArray(l?.pictures) && l.pictures.length) {
    const p0 = l.pictures.find(p => p?.large || p?.original || p?.regular || p?.thumbnail) || l.pictures[0];
    heroImage = p0?.large || p0?.original || p0?.regular || p0?.thumbnail || null;
  }
  if (!heroImage && Array.isArray(l?.images) && l.images.length) {
    heroImage = l.images[0]?.url || null;
  }

  return { id, name, bedrooms, bathrooms, priceUSD, location, heroImage };
}

export async function fetchAllListings(guestyToken, limit = 50) {
  const api = await createClient(guestyToken);
  const results = [];
  let cursor = null;

  while (true) {
    const params = { limit };
    if (cursor) params.cursor = cursor;

    let data;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const r = await api.get('/listings', { params });
        data = r.data;
        break;
      } catch (e) {
        if (e?.response?.status === 429 && attempt < 5) {
          const waitTimeMs = handleRateLimit(e, attempt);
          await sleep(waitTimeMs);
          continue;
        }
        throw e;
      }
    }

    const chunk =
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.data)    ? data.data    : [];
    results.push(...chunk);

    const next = getNextCursor(data);
    if (!next) break;
    cursor = next;
    await sleep(100);
  }
  return results;
}

export async function fetchListingById(guestyToken, id) {
  const api = await createClient(guestyToken);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data } = await api.get(`/listings/${id}`);
      return data;
    } catch (e) {
      if (e?.response?.status === 429 && attempt < 5) {
        const waitTimeMs = handleRateLimit(e, attempt);
        await sleep(waitTimeMs);
        continue;
      }
      throw e;
    }
  }
  return null;
}

export async function fetchAvailability(guestyToken, id, checkIn, checkOut) {
  const api = await createClient(guestyToken);

  const cacheKey = `availability:${id}:${checkIn}:${checkOut}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    console.log(`[Guesty] HIT availability ${id}`);
    return cachedData;
  }

  const endpoint = `/listings/${id}/availability`;
  const params = { checkIn, checkOut };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[Guesty] MISS availability ${id} (attempt ${attempt}/5)`);
      const { data } = await api.get(endpoint, { params });
      cache.set(cacheKey, data);
      return data;
    } catch (e) {
      if (e?.response?.status === 429 && attempt < 5) {
        const waitTimeMs = handleRateLimit(e, attempt);
        await sleep(waitTimeMs);
        continue;
      }
      if (e?.response?.status === 429) {
        const waitTimeMs = handleRateLimit(e, attempt);
        const err = new Error('Rate limit exceeded after multiple retries.');
        err.status = 429;
        err.waitTimeMs = waitTimeMs;
        throw err;
      }
      throw e;
    }
  }
}
 
export function extractImageUrlsFromListing(l) {
  const urls = [];
  const push = (u) => { if (u && typeof u === 'string') urls.push(u); };

  if (l?.picture) push(l.picture.large || l.picture.original || l.picture.regular || l.picture.thumbnail);
  if (Array.isArray(l?.pictures)) for (const p of l.pictures) push(p?.large || p?.original || p?.regular || p?.thumbnail);
  if (Array.isArray(l?.images)) for (const p of l.images) push(p?.url);
  if (l?.coverPhoto?.url) push(l.coverPhoto.url);
  if (Array.isArray(l?.media?.photos)) for (const p of l.media.photos) push(p?.url || p?.large || p?.original);
  if (Array.isArray(l?.gallery)) for (const p of l.gallery) push(p?.url);
  if (Array.isArray(l?.galleryImages)) for (const p of l.galleryImages) push(p?.url);
  if (Array.isArray(l?.photos)) for (const p of l.photos) push(p?.url || p?.large || p?.original);

  const seen = new Set();
  const out = [];
  for (const u of urls) if (u && !seen.has(u)) { seen.add(u); out.push(u); }

  return out.slice(0, 50);
}

export function extractDetailFields(detail) {
  const out = { description: null, amenities: [] };

  const marketing =
    detail?.marketingDescription ||
    detail?.marketingDescriptions ||
    detail?.channelDescriptions || null;

  if (marketing) {
    const primary =
      marketing.primary ||
      marketing.default ||
      (Array.isArray(marketing) ? marketing.find(m => m?.name === 'Primary' || m?.name === 'primary') : null);
    if (primary) {
      const desc =
        primary.body || primary.description || primary.summary || primary.text || null;
      if (desc && typeof desc === 'string') out.description = desc.trim();
    }
  }
  if (!out.description && detail?.publicDescription?.summary) {
    out.description = detail.publicDescription.summary.trim();
  } else if (!out.description && detail?.description) {
    out.description = String(detail.description).trim();
  }

  const rawA = detail?.amenities || detail?.amenitiesList || detail?.space?.amenities || [];
  if (Array.isArray(rawA)) {
    out.amenities = rawA
      .map(a => (typeof a === 'string' ? a.trim() : a?.name || a?.title || ''))
      .filter(Boolean)
      .slice(0, 50);
  }
  return out;
}
