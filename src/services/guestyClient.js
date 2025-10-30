import axios from 'axios';
import { getGuestyAccessToken, forceRefreshGuestyToken } from './guestyAuth.js';
import { guestyLimiter } from './guestyLimiter.js';

// Cliente "raw" solo para ejecutar la request final
const raw = axios.create({
  baseURL: 'https://open-api.guesty.com',
  timeout: 15000,
});

/**
 * Envoltorio con:
 * - Rate limit global (guestyLimiter.schedule)
 * - Inyección de Bearer token válido
 * - Retry 1 vez ante 401/403 (refresh token)
 */
async function scheduledRequest(method, url, cfg = {}) {
  return guestyLimiter.schedule(async () => {
    // 1) Token vigente
    const token = await getGuestyAccessToken();
    const headers = { ...(cfg.headers || {}), Authorization: `Bearer ${token}` };

    try {
      // 2) Disparar request
      return await raw.request({ method, url, ...cfg, headers });
    } catch (e) {
      const status = e?.response?.status;
      // 3) Si permiso/token cayeron, refrescar y reintentar 1 vez
      if ((status === 401 || status === 403) && !cfg.__retriedOnce) {
        const fresh = await forceRefreshGuestyToken();
        const retryHeaders = { ...headers, Authorization: `Bearer ${fresh}` };
        return await raw.request({ method, url, ...cfg, headers: retryHeaders, __retriedOnce: true });
      }
      throw e;
    }
  });
}

// API estilo axios que ya pasa por limiter + auth
export const guesty = {
  get: (url, cfg)    => scheduledRequest('GET', url, cfg),
  post: (url, data, cfg = {}) => scheduledRequest('POST', url, { ...cfg, data }),
  put: (url, data, cfg = {})  => scheduledRequest('PUT', url, { ...cfg, data }),
  patch: (url, data, cfg = {})=> scheduledRequest('PATCH', url, { ...cfg, data }),
  delete: (url, cfg) => scheduledRequest('DELETE', url, cfg),
};
