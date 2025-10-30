import axios from 'axios';
import { pool } from '../db.js';

const OAUTH_URL = 'https://open-api.guesty.com/oauth2/token';

// ⚙️ credenciales en env o BD (recomendado env):
const CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;

// Cache en memoria para rapidez
let TOKEN = null;           // string
let EXPIRES_AT = 0;         // epoch ms
let INFLIGHT_PROMISE = null; // evita "stampede" en concurrencia

// margen de seguridad para renovar antes del vencimiento
const SKEW_MS = 5 * 60 * 1000; // 5 min

// (Opcional) Persistencia en BD para múltiples instancias
async function readTokenFromDB() {
  const { rows } = await pool.query(
    `select value, extract(epoch from updated_at)*1000 as ts
     from settings where key='GUESTY_OAUTH_TOKEN'`
  );
  const token = rows?.[0]?.value || null;
  const { rows: rowsExp } = await pool.query(
    `select value from settings where key='GUESTY_OAUTH_EXPIRES_AT'`
  );
  const expiresAt = rowsExp?.[0]?.value ? Number(rowsExp[0].value) : 0;
  return { token, expiresAt };
}
async function writeTokenToDB(token, expiresAt) {
  await pool.query(`
    insert into settings(key,value) values('GUESTY_OAUTH_TOKEN', $1)
    on conflict(key) do update set value=excluded.value, updated_at=now()
  `,[token]);
  await pool.query(`
    insert into settings(key,value) values('GUESTY_OAUTH_EXPIRES_AT', $1)
    on conflict(key) do update set value=excluded.value, updated_at=now()
  `,[String(expiresAt)]);
}

function isValid() {
  return TOKEN && Date.now() + SKEW_MS < EXPIRES_AT;
}

async function requestNewToken() {
  const resp = await axios.post(
    OAUTH_URL,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'open-api',
    }),
    { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { access_token, expires_in } = resp.data || {};
  if (!access_token || !expires_in) {
    throw new Error('Guesty OAuth: respuesta inválida');
  }
  // calcular expires_at en ms
  const expiresAt = Date.now() + (Number(expires_in) * 1000);
  TOKEN = access_token;
  EXPIRES_AT = expiresAt;

  // persistir (opcional, recomendado si tienes >1 instancia)
  try { await writeTokenToDB(TOKEN, EXPIRES_AT); } catch {}

  return TOKEN;
}

/** Devuelve un token válido, renovando si hace falta (con lock) */
export async function getGuestyAccessToken() {
  if (isValid()) return TOKEN;

  // Intento: cargar de BD (p/ arranque de otra instancia)
  if (!TOKEN) {
    try {
      const { token, expiresAt } = await readTokenFromDB();
      if (token && expiresAt && Date.now() + SKEW_MS < Number(expiresAt)) {
        TOKEN = token;
        EXPIRES_AT = Number(expiresAt);
        return TOKEN;
      }
    } catch {}
  }

  // Evitar múltiples llamadas paralelas a oauth2/token
  if (!INFLIGHT_PROMISE) {
    INFLIGHT_PROMISE = (async () => {
      try {
        return await requestNewToken();
      } finally {
        INFLIGHT_PROMISE = null;
      }
    })();
  }
  return INFLIGHT_PROMISE;
}

/** Fuerza renovación inmediata (para 401/403) */
export async function forceRefreshGuestyToken() {
  TOKEN = null;
  EXPIRES_AT = 0;
  return getGuestyAccessToken();
}