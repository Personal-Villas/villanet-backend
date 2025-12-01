import 'dotenv/config';

const { RECAPTCHA_SECRET_KEY } = process.env;

/**
 * Verifica un token de reCAPTCHA v3 contra la API de Google
 * @param {string} token - Token que viene del frontend
 * @param {string | undefined} remoteIp - IP del usuario (opcional)
 * @param {string | undefined} expectedAction - Acción esperada (ej: 'property_message')
 */
export async function verifyRecaptcha(token, remoteIp, expectedAction) {
  if (!RECAPTCHA_SECRET_KEY) {
    throw new Error('RECAPTCHA_SECRET_KEY no está configurado');
  }

  const params = new URLSearchParams();
  params.append('secret', RECAPTCHA_SECRET_KEY);
  params.append('response', token);
  if (remoteIp) params.append('remoteip', remoteIp);

  // Node 18+ ya tiene fetch; si usas una versión vieja, instala node-fetch
  const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await response.json();
  console.log('reCAPTCHA response:', data);

  if (!data.success) {
    return { ok: false, reason: 'recaptcha_failed', data };
  }

  // Para v3: chequeamos score y action (opcional pero recomendado)
  if (typeof data.score === 'number' && data.score < 0.3) {
    return { ok: false, reason: 'low_score', data };
  }

  if (expectedAction && data.action && data.action !== expectedAction) {
    return { ok: false, reason: 'invalid_action', data };
  }

  return { ok: true, score: data.score, data };
}