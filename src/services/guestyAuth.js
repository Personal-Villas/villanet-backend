import { pool } from "../db.js";

/**
 * Settings keys en DB (solo para Open API token)
 */
const KEY_OA_TOKEN = "GUESTY_OAUTH_TOKEN";
const KEY_OA_EXPIRES_AT = "GUESTY_OAUTH_EXPIRES_AT";

/**
 * Cache en memoria (soft TTL para evitar hits constantes a DB)
 */
let MEM_OA_TOKEN = null;
let MEM_OA_EXPIRES_AT = 0;
let MEM_OA_FETCHED_AT = 0;

const SOFT_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Helpers DB
 */
async function readSettings(keys) {
  const { rows } = await pool.query(
    `SELECT key, value, extract(epoch from updated_at)*1000 as updated_ms
     FROM settings
     WHERE key = ANY($1::text[])`,
    [keys]
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return map;
}

async function upsertSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value ?? "")]
  );
}

function nowMs() {
  return Date.now();
}

function looksLikeJwt(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  return parts.length === 3;
}

function isExpired(expiresAtMs, skewMs = 3600000) {
  // 1 hora de skew
  if (!expiresAtMs || !Number.isFinite(expiresAtMs)) return true;
  return nowMs() + skewMs >= expiresAtMs;
}

/**
 * =========================
 * Open API Token
 * =========================
 * Lee desde settings en DB y cachea por unos minutos.
 */
async function readOpenApiTokenFromDB() {
  const map = await readSettings([KEY_OA_TOKEN, KEY_OA_EXPIRES_AT]);
  const token = map.get(KEY_OA_TOKEN) || null;
  const expiresAt = Number(map.get(KEY_OA_EXPIRES_AT)) || 0;

  if (!token) {
    throw new Error(
      `Guesty OAuth token not found in settings (${KEY_OA_TOKEN}).`
    );
  }
  return { token, expiresAt };
}

export async function getGuestyAccessToken() {
  const now = nowMs();
  const freshEnough = now - MEM_OA_FETCHED_AT < SOFT_TTL_MS;

  if (MEM_OA_TOKEN && freshEnough) return MEM_OA_TOKEN;

  const { token, expiresAt } = await readOpenApiTokenFromDB();
  MEM_OA_TOKEN = token;
  MEM_OA_EXPIRES_AT = expiresAt || 0;
  MEM_OA_FETCHED_AT = now;
  return MEM_OA_TOKEN;
}

export async function forceRefreshGuestyToken() {
  MEM_OA_TOKEN = null;
  MEM_OA_EXPIRES_AT = 0;
  MEM_OA_FETCHED_AT = 0;
  return getGuestyAccessToken();
}

export function getCachedGuestyExpiry() {
  return MEM_OA_EXPIRES_AT || 0;
}