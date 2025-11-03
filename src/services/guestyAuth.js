import { pool } from '../db.js';

/**
 * Lee SIEMPRE el token desde la BD (tabla settings),
 * sin pedirlo a OAuth ni escribir nada.
 *
 * El cron externo se encargará de renovarlo y actualizar
 * la fila 'GUESTY_OAUTH_TOKEN' (y opcionalmente 'GUESTY_OAUTH_EXPIRES_AT').
 */

const KEY_TOKEN = 'GUESTY_OAUTH_TOKEN';
const KEY_EXPIRES_AT = 'GUESTY_OAUTH_EXPIRES_AT';

// cache en memoria para evitar hits constantes a la BD
let MEM_TOKEN = null;
let MEM_EXPIRES_AT = 0;      // opcional: si guardás expires en la BD
let MEM_FETCHED_AT = 0;

const SOFT_TTL_MS = 5 * 60 * 1000; // 5 min (relee desde BD pasado este tiempo)

/** Lee el token (y opcionalmente el expires) desde BD */
async function readTokenFromDB() {
  const { rows } = await pool.query(
    `SELECT key, value, extract(epoch from updated_at)*1000 as updated_ms
     FROM settings
     WHERE key IN ($1, $2)`,
    [KEY_TOKEN, KEY_EXPIRES_AT]
  );

  let token = null;
  let expiresAt = 0;

  for (const r of rows) {
    if (r.key === KEY_TOKEN) token = r.value;
    if (r.key === KEY_EXPIRES_AT) expiresAt = Number(r.value) || 0;
  }
  if (!token) {
    throw new Error('Guesty OAuth token not found in settings (GUESTY_OAUTH_TOKEN).');
  }
  return { token, expiresAt };
}

/** Devuelve un token válido leído desde BD (cacheado unos minutos) */
export async function getGuestyAccessToken() {
  const now = Date.now();
  const freshEnough = (now - MEM_FETCHED_AT) < SOFT_TTL_MS;

  // si está fresco en memoria, úsalo
  if (MEM_TOKEN && freshEnough) {
    return MEM_TOKEN;
  }

  // relee desde BD
  const { token, expiresAt } = await readTokenFromDB();
  MEM_TOKEN = token;
  MEM_EXPIRES_AT = expiresAt || 0;
  MEM_FETCHED_AT = now;
  return MEM_TOKEN;
}

/**
 * Forzar recarga desde BD (p.ej. al recibir 401/403 desde Guesty,
 * o cuando el cron ya actualizó el token y queremos tomarlo).
 */
export async function forceRefreshGuestyToken() {
  MEM_TOKEN = null;
  MEM_EXPIRES_AT = 0;
  MEM_FETCHED_AT = 0;
  // lee inmediatamente el nuevo valor desde BD
  return getGuestyAccessToken();
}

// (Opcional) exportar el expires por si querés loguearlo
export function getCachedGuestyExpiry() {
  return MEM_EXPIRES_AT || 0;
}
