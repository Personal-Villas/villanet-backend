import { Router } from 'express';
import { pool } from '../db.js';
import { auth } from '../middleware/auth.js';
import { verifyRecaptcha } from '../services/recaptcha.service.js';
import { sendEmail } from '../services/email.service.js';
import { sendInquiryNotification, notifySafely } from '../services/discordNotification.service.js';

const r = Router();

const PROPERTY_MESSAGES_TO =
  process.env.PROPERTY_MESSAGES_TO ||
  'nico_204@hotmail.com,jhony@personalvillas.com';

/**
 * POST /public/property-messages
 * auth(false) — opcional: popula req.user si hay JWT válido, sin rechazar anónimos
 */
r.post('/property-messages', auth(false), async (req, res) => {
  try {
    const { listingId, message, recaptchaToken } = req.body || {};

    if (!listingId)      return res.status(400).json({ error: 'listingId is required' });
    if (!message)        return res.status(400).json({ error: 'message is required' });
    if (!recaptchaToken) return res.status(400).json({ error: 'recaptchaToken is required' });

    const remoteIp =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      undefined;

    const recaptchaResult = await verifyRecaptcha(recaptchaToken, remoteIp, 'property_message');
    if (!recaptchaResult.ok) {
      return res.status(400).json({ error: 'Failed reCAPTCHA verification' });
    }

    const cleanMessage = message.trim().slice(0, 1000);
    const userAgent = req.headers['user-agent']?.toString().slice(0, 255) || null;

    // ── Usuario logueado (opcional) ───────────────────────────────────────────
    // email viene en el JWT payload; full_name requiere una query a la BD
    const clientEmail = req.user?.email || null;
    let clientName = null;

    if (req.user?.sub) {
      try {
        const { rows: userRows } = await pool.query(
          'SELECT full_name FROM users WHERE id = $1 LIMIT 1',
          [req.user.sub]
        );
        clientName = userRows[0]?.full_name || null;
      } catch (e) {
        console.warn('Could not fetch user name for Discord notification:', e.message);
      }
    }

    // ── Guardar mensaje en BD ─────────────────────────────────────────────────
    const { rows } = await pool.query(
      `INSERT INTO property_messages
         (listing_id, message, recaptcha_score, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [listingId, cleanMessage, recaptchaResult.score ?? null, remoteIp ?? null, userAgent]
    );

    const messageId = rows[0]?.id;
    const createdAt = rows[0]?.created_at;

    // ── Traer info de la property ─────────────────────────────────────────────
    let listingName = listingId;
    let listingLocation = '';

    try {
      const { rows: listingRows } = await pool.query(
        'SELECT name, location_text FROM listings WHERE listing_id = $1',
        [listingId]
      );
      if (listingRows.length) {
        listingName     = listingRows[0].name          || listingName;
        listingLocation = listingRows[0].location_text || '';
      }
    } catch (e) {
      console.warn('Could not fetch listing info:', e);
    }

    // ── Email al equipo ───────────────────────────────────────────────────────
    try {
      await sendEmail({
        to: PROPERTY_MESSAGES_TO,
        subject: `💬 New Villa Inquiry: ${listingName}`,
        html: `
          <h1 style="font-size:20px; margin-bottom:5px;">New Inquiry Received</h1>
          <h2 style="color:#2c3e50; margin-top:0;">🏡 ${listingName}</h2>
          ${listingLocation ? `<p><strong>Location:</strong> ${listingLocation}</p>` : ''}
          <p><strong>Listing ID:</strong> ${listingId}</p>
          <hr style="margin:20px 0;">
          <p><strong>Message:</strong></p>
          <p style="white-space:pre-line;">${cleanMessage}</p>
          <hr style="margin:20px 0;">
          <p><strong>Message ID:</strong> ${messageId}</p>
          <p><strong>Received at:</strong> ${createdAt}</p>
          <p><strong>reCAPTCHA Score:</strong> ${recaptchaResult.score}</p>
          <p><strong>IP:</strong> ${remoteIp || 'N/A'}</p>
          <p><strong>User-Agent:</strong> ${userAgent || 'N/A'}</p>
          <br><br>
          <p style="font-size:12px; color:#888;">This notification was generated automatically by VillaNet.</p>
        `,
      });
    } catch (emailErr) {
      console.error('Email sending failed:', emailErr);
    }

    // ── Discord (no bloquea la respuesta aunque falle) ────────────────────────
    notifySafely(() => sendInquiryNotification({
      villaId:     listingId,
      villaName:   listingName,
      message:     cleanMessage,
      clientEmail,
      clientName,
      villaUrl:    `https://thevillanet.com/property/${listingId}`,
    }));

    return res.json({ success: true, id: messageId });

  } catch (err) {
    console.error('Error in POST /public/property-messages:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default r;