import { pool } from "../db.js";
import { cache } from "../cache.js";

const RATES_TTL_MS = 30 * 60 * 1000; 

const keyOf = (id) => String(id ?? "");

export async function getRatesMap(listingIds = []) {
  const out = new Map();
  const missing = [];

  for (const rawId of listingIds) {
    const id = keyOf(rawId);
    if (!id) continue;

    const cached = cache.get(`rates:${id}`);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }

  if (missing.length) {
    const { rows } = await pool.query(
      `
      SELECT listing_id,
             base_price_usd,
             mandatory_fees,
             original_currency,
             last_sync_at
      FROM listing_rates
      WHERE listing_id = ANY($1::text[])
      `,
      [missing]
    );

    for (const r of rows) {
      const id = keyOf(r.listing_id);

      const payload = {
        baseUSD: Number(r.base_price_usd || 0),
        fees: r.mandatory_fees ?? {},
        originalCurrency: r.original_currency || "USD",
        updated: r.last_sync_at || null,
        source: "guesty_sync_db",
      };

      out.set(id, payload);
      cache.set(`rates:${id}`, payload, RATES_TTL_MS);
    }
  }

  return out;
}

export function applyRatesToRows(rows = [], ratesMap) {
  return rows.map((r) => {
    const id = keyOf(r.id);
    const rate = ratesMap?.get(id);

    if (!rate) {
      return {
        ...r,
        mandatoryFees: r.mandatoryFees ?? {},
        rateUpdatedAt: r.rateUpdatedAt ?? null,
        rateSource: r.rateSource ?? "listing_price_usd",
        originalCurrency: r.originalCurrency ?? null,
      };
    }

    const priceUSD = rate.baseUSD > 0 ? rate.baseUSD : Number(r.priceUSD || 0);

    return {
      ...r,
      id, // opcional pero ayuda a consistencia
      priceUSD,
      mandatoryFees: rate.fees ?? {},
      rateUpdatedAt: rate.updated ?? null,
      rateSource: rate.source ?? "guesty_sync",
      originalCurrency: rate.originalCurrency ?? null,
    };
  });
}
