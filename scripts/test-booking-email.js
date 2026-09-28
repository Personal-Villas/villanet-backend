// scripts/test-booking-email.js
// Uso: node scripts/test-booking-email.js
// Envía SOLO la confirmación al huésped (mismo HTML que booking.routes.js).
// No toca DB. No manda aviso al equipo.

import "dotenv/config";
import { sendEmail } from "../src/services/email.service.js";

const TO = "nico_204@hotmail.com";

const propertyName = "Test Villa — Email Preview";
const firstName = "Nico";
const checkIn = "2026-12-01";
const checkOut = "2026-12-08";
const guests = 4;

const LOGO_URL =
  process.env.EMAIL_LOGO_URL ||
  "https://agents.personalvillas.com/email-logo.png";
const PRIMARY_COLOR = "#006699";

const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; border: 1px solid #dddddd; padding: 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px;">
      <tr>
        <td align="center" style="padding-bottom: 10px; border-bottom: 3px solid ${PRIMARY_COLOR};">
          <img src="${LOGO_URL}" alt="Personal Villas Agents Logo" width="150" style="display: block; border: 0;" />
        </td>
      </tr>
    </table>

    <h1 style="color: ${PRIMARY_COLOR}; font-size: 24px; text-align: center;">Request Received!</h1>

    <p>Dear ${firstName},</p>

    <p>Thank you for your interest in ${propertyName}. We have received your reservation request and our team will contact you shortly to confirm availability and finalize details.</p>

    <div style="background-color: #f9f9f9; border-left: 5px solid ${PRIMARY_COLOR}; padding: 15px; margin: 20px 0;">
      <h3 style="margin-top: 0; color: ${PRIMARY_COLOR};">Details of your request:</h3>
      <p style="margin: 5px 0;"><strong>Property:</strong> ${propertyName}</p>
      <p style="margin: 5px 0;"><strong>Check-in:</strong> <span style="font-weight: bold; color: #555;">${checkIn}</span></p>
      <p style="margin: 5px 0;"><strong>Check-out:</strong> <span style="font-weight: bold; color: #555;">${checkOut}</span></p>
      <p style="margin: 5px 0;"><strong>Guests:</strong> ${guests}</p>
    </div>

    <p><strong>What happens now?</strong></p>
    <p>We will review the details and an expert agent will contact you by email or phone to advance with your reservation.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px; border-top: 1px solid #dddddd; padding-top: 15px;">
      <tr>
        <td align="center">
          <p style="font-size: 12px; color: #999999; margin: 0;">
            Best regards,<br>
            The Personal Villas Agents Team<br>
            <a href="mailto:reservations@personalvillas.com" style="color: ${PRIMARY_COLOR}; text-decoration: none;">reservations@personalvillas.com</a>
          </p>
        </td>
      </tr>
    </table>
  </div>
`;

async function main() {
  console.log(`Enviando confirmación de booking SOLO a ${TO}…`);
  await sendEmail({
    to: TO,
    subject: `✅ Confirmation of request for ${propertyName}`,
    html,
  });
  console.log("Listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
