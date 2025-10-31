import axios from 'axios';
import { pool } from '../db.js';

const OAUTH_URL = 'https://open-api.guesty.com/oauth2/token';
const CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;

let TOKEN = null;
let EXPIRES_AT = 0;
let INFLIGHT_PROMISE = null;
let OAUTH_BLOCKED_UNTIL = 0; // Cooldown tras 429

const SKEW_MS = 5 * 60 * 1000; // 5 minutos de margen
const OAUTH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutos de cooldown

/**
 * Lee el token desde la base de datos
 */
async function readTokenFromDB() {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE key='GUESTY_OAUTH_TOKEN'`
    );
    const token = rows?.[0]?.value || null;
    
    const { rows: rowsExp } = await pool.query(
      `SELECT value FROM settings WHERE key='GUESTY_OAUTH_EXPIRES_AT'`
    );
    const expiresAt = rowsExp?.[0]?.value ? Number(rowsExp[0].value) : 0;

    // Validar que no haya expirado
    if (token && expiresAt && Date.now() + SKEW_MS < expiresAt) {
      console.log('[GuestyAuth] Token válido en DB, expira:', new Date(expiresAt).toISOString());
      return { token, expiresAt };
    }
    
    if (token && expiresAt) {
      console.log('[GuestyAuth] Token en DB expirado');
    }
    
    return { token: null, expiresAt: 0 };
  } catch (err) {
    console.error('[GuestyAuth] Error leyendo de DB:', err.message);
    return { token: null, expiresAt: 0 };
  }
}

/**
 * Guarda el token en la base de datos
 */
async function writeTokenToDB(token, expiresAt) {
  try {
    await pool.query(`
      INSERT INTO settings(key, value) 
      VALUES('GUESTY_OAUTH_TOKEN', $1)
      ON CONFLICT(key) DO UPDATE 
      SET value=excluded.value, updated_at=now()
    `, [token]);

    await pool.query(`
      INSERT INTO settings(key, value) 
      VALUES('GUESTY_OAUTH_EXPIRES_AT', $1)
      ON CONFLICT(key) DO UPDATE 
      SET value=excluded.value, updated_at=now()
    `, [String(expiresAt)]);
    
    console.log('[GuestyAuth] Token guardado en DB');
  } catch (err) {
    console.error('[GuestyAuth] Error guardando en DB:', err.message);
  }
}

/**
 * Verifica si el token en memoria es válido
 */
function isValid() {
  return TOKEN && Date.now() + SKEW_MS < EXPIRES_AT;
}

/**
 * Solicita un nuevo token OAuth a Guesty
 */
async function requestNewToken() {
  // Verificar si estamos en cooldown por 429
  const now = Date.now();
  if (now < OAUTH_BLOCKED_UNTIL) {
    const waitSeconds = Math.ceil((OAUTH_BLOCKED_UNTIL - now) / 1000);
    const waitMinutes = Math.ceil(waitSeconds / 60);
    throw new Error(`OAuth endpoint bloqueado por rate limit. Reintenta en ${waitMinutes} minutos.`);
  }

  console.log('[GuestyAuth] Solicitando nuevo token OAuth...');

  try {
    const resp = await axios.post(
      OAUTH_URL,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'open-api',
      }),
      { 
        timeout: 15000, 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
      }
    );

    const { access_token, expires_in } = resp.data || {};
    if (!access_token || !expires_in) {
      throw new Error('Respuesta OAuth inválida: falta access_token o expires_in');
    }

    TOKEN = access_token;
    EXPIRES_AT = Date.now() + (Number(expires_in) * 1000);

    await writeTokenToDB(TOKEN, EXPIRES_AT);
    
    console.log('[GuestyAuth] ✅ Nuevo token obtenido');
    console.log('[GuestyAuth] Expira:', new Date(EXPIRES_AT).toISOString());
    
    return TOKEN;
  } catch (err) {
    // Si recibimos 429, activar cooldown
    if (err?.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'];
      
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (Number.isFinite(seconds) && seconds > 0) {
          OAUTH_BLOCKED_UNTIL = Date.now() + (seconds * 1000);
        } else {
          OAUTH_BLOCKED_UNTIL = Date.now() + OAUTH_COOLDOWN_MS;
        }
      } else {
        OAUTH_BLOCKED_UNTIL = Date.now() + OAUTH_COOLDOWN_MS;
      }
      
      const blockedUntil = new Date(OAUTH_BLOCKED_UNTIL).toISOString();
      console.error(`[GuestyAuth] ❌ 429 en endpoint OAuth. Bloqueado hasta: ${blockedUntil}`);
      
      throw new Error(`Rate limit en OAuth. Bloqueado hasta ${blockedUntil}`);
    }
    
    console.error('[GuestyAuth] Error obteniendo token:', err.message);
    throw err;
  }
}

/**
 * Obtiene un token válido (memoria → DB → nuevo request)
 */
export async function getGuestyAccessToken() {
  // 1. Si hay token válido en memoria, usarlo
  if (isValid()) {
    return TOKEN;
  }

  // 2. Intentar cargar desde DB
  if (!TOKEN || !isValid()) {
    const { token, expiresAt } = await readTokenFromDB();
    if (token && expiresAt) {
      TOKEN = token;
      EXPIRES_AT = Number(expiresAt);
      console.log('[GuestyAuth] ✅ Token cargado desde DB');
      return TOKEN;
    }
  }

  // 3. Si estamos bloqueados por 429, lanzar error inmediatamente
  const now = Date.now();
  if (now < OAUTH_BLOCKED_UNTIL) {
    const waitSeconds = Math.ceil((OAUTH_BLOCKED_UNTIL - now) / 1000);
    const waitMinutes = Math.ceil(waitSeconds / 60);
    throw new Error(`OAuth bloqueado por rate limit. Reintenta en ${waitMinutes} minutos.`);
  }

  // 4. Solicitar nuevo token (evitar múltiples requests simultáneos)
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

/**
 * Fuerza un refresh del token (usar con cuidado)
 */
export async function forceRefreshGuestyToken() {
  console.log('[GuestyAuth] Forzando refresh de token...');
  TOKEN = null;
  EXPIRES_AT = 0;
  return getGuestyAccessToken();
}