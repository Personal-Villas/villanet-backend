import axios from "axios";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "../../.guesty_be_token.json");

let tokenPromise = null;

// ─── Token persistence ────────────────────────────────────────────────────────

function readTokenFromDisk() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (data.token && data.expiry && Date.now() < data.expiry) {
        console.log("[BookingEngine] Token loaded from disk, valid until", new Date(data.expiry).toISOString());
        return { token: data.token, expiry: data.expiry };
      }
    }
  } catch (e) {
    console.warn("[BookingEngine] Could not read token file:", e.message);
  }
  return null;
}

function saveTokenToDisk(token, expiry) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiry }), "utf-8");
  } catch (e) {
    console.warn("[BookingEngine] Could not save token to disk:", e.message);
  }
}

async function getBookingEngineToken() {
  const cached = readTokenFromDisk();
  if (cached) return cached.token;

  if (tokenPromise) {
    try { return await tokenPromise; }
    catch { tokenPromise = null; }
  }

  const clientId     = process.env.GUESTY_BOOKING_ENGINE_CLIENT_ID;
  const clientSecret = process.env.GUESTY_BOOKING_ENGINE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "[BookingEngine] Credentials not configured. " +
      "Set GUESTY_BOOKING_ENGINE_CLIENT_ID and GUESTY_BOOKING_ENGINE_CLIENT_SECRET in .env"
    );
  }

  tokenPromise = (async () => {
    try {
      const response = await axios.post(
        "https://booking.guesty.com/oauth2/token",
        new URLSearchParams({
          grant_type:    "client_credentials",
          client_id:     clientId,
          client_secret: clientSecret,
          scope:         "booking_engine:api",
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const token     = response.data.access_token;
      const expiresIn = response.data.expires_in || 86400;
      const expiry    = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;

      saveTokenToDisk(token, expiry);
      console.log("[BookingEngine] New token obtained, expires", new Date(expiry).toISOString());
      return token;
    } catch (error) {
      console.error("[BookingEngine] Failed to get token:", error.response?.data?.error_description || error.message);
      throw new Error("Failed to authenticate with Guesty Booking Engine API: " + (error.response?.data?.error_description || error.message));
    } finally {
      tokenPromise = null;
    }
  })();

  return await tokenPromise;
}

// ─── Axios client ─────────────────────────────────────────────────────────────

export const bookingEngineClient = axios.create({
  baseURL: "https://booking.guesty.com/api",
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

bookingEngineClient.interceptors.request.use(
  async (config) => {
    try {
      config.headers.Authorization = `Bearer ${await getBookingEngineToken()}`;
      return config;
    } catch (error) {
      console.error("[BookingEngine] Token error in interceptor:", error.message);
      return Promise.reject(error);
    }
  },
  (error) => Promise.reject(error)
);

bookingEngineClient.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error("[BookingEngine] Request failed:", {
      method: error.config?.method?.toUpperCase(),
      url:    error.config?.url,
      status: error.response?.status,
    });
    return Promise.reject(error);
  }
);

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getBookingEngineQuote(listingId, checkIn, checkOut, guests = 1) {
  const payload = {
    listingId,
    checkInDateLocalized:  checkIn,
    checkOutDateLocalized: checkOut,
    guestsCount: Number(guests) || 1,
    source: "website",
  };

  const response = await bookingEngineClient.post("/reservations/quotes", payload);
  return response.data;
}