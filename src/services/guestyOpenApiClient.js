import Bottleneck from "bottleneck";
import axios from "axios";
import { getGuestyAccessToken, forceRefreshGuestyToken } from "./guestyAuth.js";

const limiter = new Bottleneck({
  minTime: 300, // ~200 req/min seguro
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60000,
});

const openApi = axios.create({
  baseURL: "https://open-api.guesty.com/v1",
  timeout: 15000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "VillaNet-Backend/2.0 (OpenAPI)",
  },
});

// Interceptor para token con LOG TEMPORAL
openApi.interceptors.request.use(async (config) => {
  const token = await getGuestyAccessToken();
  config.headers.Authorization = `Bearer ${token}`;
  
  // LOG TEMPORAL - Agregado para debugging
  console.log("📤 [OpenAPI] Request:", config.method?.toUpperCase(), config.url);
  console.log("📤 [OpenAPI] Params:", config.params);
  console.log("📤 [OpenAPI] Body:", config.data ? JSON.stringify(config.data) : "(no body)");
  console.log("📤 [OpenAPI] Headers:", {
    Authorization: `Bearer ${token.substring(0, 20)}...`, // solo primeros 20 chars por seguridad
    ...config.headers
  });
  
  return config;
});

// Rate limit + retry simple
export const guestyOA = {
  post: async (url, data, params = {}) => {
    return limiter.schedule(async () => {
      try {
        const resp = await openApi.post(url, data, { params });
        return resp;
      } catch (e) {
        if (e.response?.status === 401) {
          console.log("🔄 [OpenAPI] 401 detectado, forzando refresh token y reintentando...");
          // Forzar refresh token si 401
          await forceRefreshGuestyToken();
          const retryResp = await openApi.post(url, data, { params });
          return retryResp;
        }
        throw e;
      }
    });
  },
  get: async (url, params = {}) => {
    return limiter.schedule(async () => {
      try {
        const resp = await openApi.get(url, { params });
        return resp;
      } catch (e) {
        if (e.response?.status === 401) {
          console.log("🔄 [OpenAPI] 401 detectado, forzando refresh token y reintentando...");
          await forceRefreshGuestyToken();
          const retryResp = await openApi.get(url, { params });
          return retryResp;
        }
        throw e;
      }
    });
  },
};