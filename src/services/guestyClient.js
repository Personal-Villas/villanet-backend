import axios from 'axios';
import { getGuestyAccessToken, forceRefreshGuestyToken } from './guestyAuth.js';

export const guesty = axios.create({
  baseURL: 'https://open-api.guesty.com',
  timeout: 15000,
});

// Inserta token válido en cada request
guesty.interceptors.request.use(async (cfg) => {
  const token = await getGuestyAccessToken();
  cfg.headers = cfg.headers || {};
  cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Si vuelve 401/403, refresca token y reintenta 1 vez
guesty.interceptors.response.use(
  r => r,
  async (error) => {
    const status = error?.response?.status;
    const original = error.config;
    if (!original || original.__retry) throw error;

    if (status === 401 || status === 403) {
      original.__retry = true;
      const fresh = await forceRefreshGuestyToken();
      original.headers = { ...(original.headers || {}), Authorization: `Bearer ${fresh}` };
      return guesty.request(original);
    }
    throw error;
  }
);