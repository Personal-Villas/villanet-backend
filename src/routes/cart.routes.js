import { Router } from 'express';
import { sendEmail } from '../services/email.service.js';
import { generateCartPdf } from '../services/cartPdf.service.js';

const router = Router();

/**
 * POST /cart/export-pdf
 * Body:
 * {
 *   clientName?: string,
 *   clientEmail: string,
 *   listings: Array<{
 *     id: string;
 *     name: string;
 *     location?: string;
 *     bedrooms?: number | null;
 *     bathrooms?: number | null;
 *     priceUSD?: number | null;
 *     imageUrl?: string; // ← NUEVO: URL de la imagen principal
 *   }>
 * }
 */
router.post('/export-pdf', async (req, res) => {
  try {
    const { clientName, clientEmail, listings } = req.body || {};

    if (!clientEmail) {
      return res.status(400).json({ error: 'clientEmail is required' });
    }

    if (!Array.isArray(listings) || listings.length === 0) {
      return res
        .status(400)
        .json({ error: 'At least one listing is required' });
    }

    // Generar PDF en memoria
    const pdfBuffer = await generateCartPdf(listings, { clientName });

    // HTML del email
    const safeClientName = clientName || 'your client';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #203F3C;">Your Villa Selection</h2>
        <p>Hi,</p>
        <p>Please find attached the villa selection we prepared for <strong>${safeClientName}</strong>.</p>
        <p>This PDF includes a detailed overview of each selected villa with photos, location details, and indicative nightly rates.</p>
        <p style="margin-top: 30px;">Best regards,<br/><strong>VillaNet Team</strong></p>
      </div>
    `;

    await sendEmail({
      to: clientEmail,
      subject: `${clientName ? clientName + "'s " : ''}Villa Selection – PDF Overview`,
      html,
      attachments: [
        {
          filename: 'villa-selection.pdf',
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error in /cart/export-pdf:', err);
    return res
      .status(500)
      .json({ error: 'Error generating or sending the PDF' });
  }
});

export default router;