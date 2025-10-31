import axios from 'axios';
import { getGuestyAccessToken, forceRefreshGuestyToken } from './guestyAuth.js';
import Bottleneck from 'bottleneck';

const raw = axios.create({
  baseURL: 'https://open-api.guesty.com',
  timeout: 20000,
  headers: { Accept: 'application/json' },
  // 🔧 REMOVIDO: paramsSerializer (lo haremos manualmente cuando sea necesario)
});

// ── Rate limit conservador
const limiter = new Bottleneck({
  minTime: 1200, // ~0.8 req/seg
  reservoir: 1,
  reservoirRefreshAmount: 1,
  reservoirRefreshInterval: 1000,
});

// ── Cooldown global tras 429
let pauseUntil = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitIfPaused() {
  const now = Date.now();
  if (now < pauseUntil) {
    await sleep(pauseUntil - now);
  }
}

/** Ejecuta la request respetando limiter + auth + cooldown + retry 401/403 + 429 */
async function scheduledRequest(method, url, cfg = {}) {
  return limiter.schedule(async () => {
    await waitIfPaused();

    // 1) token vigente
    const token = await getGuestyAccessToken();
    const headers = { 
      ...(cfg.headers || {}), 
      Authorization: `Bearer ${token}`, 
      Accept: 'application/json' 
    };

    try {
      // 2) dispara
      return await raw.request({ method, url, ...cfg, headers });
    } catch (e) {
      const status = e?.response?.status;

      // 3) si 401/403 → refresh y reintenta 1 vez
      if ((status === 401 || status === 403) && !cfg.__retriedOnce) {
        const fresh = await forceRefreshGuestyToken();
        const retryHeaders = { ...headers, Authorization: `Bearer ${fresh}` };
        return await raw.request({ 
          method, 
          url, 
          ...cfg, 
          headers: retryHeaders, 
          __retriedOnce: true 
        });
      }

      // 4) si 429 → setear cooldown global respetando Retry-After
      if (status === 429) {
        const ra = e?.response?.headers?.['retry-after'];
        const seconds = Number(ra);
        const waitMs = Number.isFinite(seconds) ? seconds * 1000 : 15000;
        pauseUntil = Date.now() + waitMs;
        console.warn(`[GuestyClient] ⚠️ 429 - Pausing until ${new Date(pauseUntil).toISOString()}`);
      }

      throw e;
    }
  });
}

export const guesty = {
  get: (url, cfg) => scheduledRequest('GET', url, cfg),
  post: (url, data, cfg = {}) => scheduledRequest('POST', url, { ...cfg, data }),
  put: (url, data, cfg = {}) => scheduledRequest('PUT', url, { ...cfg, data }),
  patch: (url, data, cfg = {}) => scheduledRequest('PATCH', url, { ...cfg, data }),
  delete: (url, cfg) => scheduledRequest('DELETE', url, cfg),
};