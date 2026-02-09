import axios from 'axios';
import qs from 'qs';
import Bottleneck from 'bottleneck';
import { getGuestyAccessToken, forceRefreshGuestyToken } from './guestyAuth.js';

/**
 * Cliente HTTP con:
 * - serialización de arrays como listingIds[]=
 * - rate limit MUY conservador
 * - cooldown global tras 429 respetando Retry-After
 * - reintento 1 sola vez en 401/403 forzando releer token desde BD
 */

const raw = axios.create({
  baseURL: 'https://open-api.guesty.com/v1',  // 🔄 Dominio antiguo + path moderno
  timeout: 20000,
  paramsSerializer: (params) => qs.stringify(params, { arrayFormat: 'brackets' }),
  headers: { Accept: 'application/json' },
});

// Rate limit global (ajústalo si hace falta)
const limiter = new Bottleneck({
  minTime: 1200,              // ~0.8 req/seg (conservador)
  reservoir: 1,
  reservoirRefreshAmount: 1,
  reservoirRefreshInterval: 1000,
});

// Cooldown global tras 429
let pauseUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIfPaused() {
  const now = Date.now();
  if (now < pauseUntil) await sleep(pauseUntil - now);
}

async function scheduledRequest(method, url, cfg = {}) {
  return limiter.schedule(async () => {
    await waitIfPaused();

    // 1) Token de BD
    const token = await getGuestyAccessToken();
    const headers = {
      ...(cfg.headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    try {
      // 2) Disparar
      return await raw.request({ method, url, ...cfg, headers });
    } catch (e) {
      const status = e?.response?.status;

      // 3) Si 401/403 ⇒ el token que había en memoria ya no sirve.
      //    Releer desde BD (cron lo debió actualizar) y reintentar 1 vez.
      if ((status === 401 || status === 403) && !cfg.__retriedOnce) {
        const fresh = await forceRefreshGuestyToken(); // NO pide OAuth, sólo re-lee BD
        const retryHeaders = { ...headers, Authorization: `Bearer ${fresh}` };
        return await raw.request({
          method,
          url,
          ...cfg,
          headers: retryHeaders,
          __retriedOnce: true,
        });
      }

      // 4) En 429 respetar Retry-After si viene, o aplicar pausa por defecto
      if (status === 429) {
        const ra = e?.response?.headers?.['retry-after'];
        const seconds = Number(ra);
        const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15000;
        pauseUntil = Date.now() + waitMs;
      }

      throw e;
    }
  });
}

// API estilo axios
export const guesty = {
  get: (url, cfg)                 => scheduledRequest('GET', url, cfg),
  post: (url, data, cfg = {})     => scheduledRequest('POST', url, { ...cfg, data }),
  put: (url, data, cfg = {})      => scheduledRequest('PUT', url, { ...cfg, data }),
  patch: (url, data, cfg = {})    => scheduledRequest('PATCH', url, { ...cfg, data }),
  delete: (url, cfg)              => scheduledRequest('DELETE', url, cfg),
};
