import express from 'express';
import { sendEmail } from '../services/email.service.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const {
      propertyName,
      firstName,
      lastName,
      email,
      checkIn,
      checkOut,
      guests,
    } = req.body;

    // Lista de correos electrónicos del equipo interno separados por coma
    const teamEmails = 'reservations@villanet.com, nico_204@hotmail.com, jhony@personalvillas.com';

    // 1) Email al equipo interno
    await sendEmail({
      to: process.env.SMTP_TEAM_EMAIL || teamEmails, 
      subject: `New Booking Request for ${propertyName}`,
      html: `
        <h2>New Booking Inquiry</h2>

        <p><strong>Property:</strong> ${propertyName}</p>

        <p><strong>Guest:</strong> ${firstName} ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>

        <p><strong>Check-in:</strong> ${checkIn}</p>
        <p><strong>Check-out:</strong> ${checkOut}</p>
        <p><strong>Guests:</strong> ${guests}</p>

        <hr />
        <p>This request was submitted from the public website.</p>
      `,
    });

    const LOGO_URL = 'https://i.ibb.co/rGtGY6Z4/isotype-iris.png'; 
    const PRIMARY_COLOR = '#006699';
    
    // 2) Email de confirmación al huésped
    await sendEmail({
      to: email,
      subject: `✅ Confirmation of request for ${propertyName}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; border: 1px solid #dddddd; padding: 20px;">
            
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px;">
                <tr>
                    <td align="center" style="padding-bottom: 10px; border-bottom: 3px solid ${PRIMARY_COLOR};">
                        <img src="${LOGO_URL}" alt="Villanet Logo" width="150" style="display: block; border: 0;" />
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
                            The Villanet Team<br>
                            <a href="mailto:reservations@villanet.com" style="color: ${PRIMARY_COLOR}; text-decoration: none;">reservations@villanet.com</a>
                        </p>
                    </td>
                </tr>
            </table>
        </div>
      `,
    });

    res.json({ ok: true });

  } catch (error) {
    return res.status(500).json({ error: 'Failed to send booking email.' });
  }
});

export default router;