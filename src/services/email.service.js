import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmail({ to, subject, html, attachments }) {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
      attachments,
    });

    console.log(`📨 Email sent: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error("❌ Error sending email:", error);
    throw error;
  }
}

/**
 * Envía notificación de nuevo lead de expansión al equipo
 * @param {Object} leadData - Datos del lead
 * @returns {Promise<Object>} Resultado del envío
 */
export async function sendExpansionLeadNotification(leadData) {
  const {
    full_name,
    user_email,
    location,
    check_in,
    check_out,
    bedrooms,
    bathrooms,
    min_price,
    max_price,
    guests,
    amenities,
    current_results_count,
  } = leadData;

  // Parsear amenities si es string
  let amenitiesList = [];
  try {
    amenitiesList =
      typeof amenities === "string" ? JSON.parse(amenities) : amenities || [];
  } catch (e) {
    amenitiesList = [];
  }

  const amenitiesText =
    amenitiesList.length > 0 ? amenitiesList.join(", ") : "None specified";

  const emailBody = `
    <div style="font-family: 'Helvetica', -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <!-- Header -->
      <div style="background: white; text-align: center;">
        <img 
          src="cid:logo@villanet" 
          alt="VillaNet Logo"
          style="max-width: 180px; height: auto; display: block; margin: 0 auto;"
        />
      </div>
      <div style="background: white; padding: 30px 20px; text-align: center; border-bottom: 2px solid #e0e0e0;">
        <h1 style="color: #111827; margin: 0; font-size: 28px; font-weight: 700;">
          New Property Search Request
        </h1>
        <p style="color: #475569; margin: 10px 0 0 0; font-size: 16px;">
          A user is looking for a villa
        </p>
      </div>

      <!-- Content -->
      <div style="padding: 30px 20px;">
        <!-- Contact Info Card -->
        <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <h3 style="margin: 0 0 15px 0; color: #111827; font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
            Contact Information
          </h3>
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; width: 80px;">
                <strong>Name:</strong>
              </td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">
                ${full_name || "Not provided"}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; width: 80px;">
                <strong>Email:</strong>
              </td>
              <td style="padding: 8px 0;">
                <a href="mailto:${user_email}" style="color: #111827; text-decoration: none; font-weight: 600; font-size: 15px;">
                  ${user_email}
                </a>
              </td>
            </tr>
          </table>
        </div>

        <!-- Alert Banner -->
        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
          <p style="margin: 0; color: #856404; font-size: 14px;">
            <strong>⚠️ Context:</strong> User found only <strong>${current_results_count} result${current_results_count !== 1 ? "s" : ""}</strong> with current filters.
          </p>
        </div>

        <!-- Search Details Card -->
        <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
          <h3 style="margin: 0 0 15px 0; color: #333; font-size: 16px; font-weight: 600; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px;">
            Search Requirements
          </h3>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; width: 140px;">
                <strong>Location:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${location || '<em style="color: #999;">Not specified</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>Check-in:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${check_in || '<em style="color: #999;">Flexible</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>Check-out:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${check_out || '<em style="color: #999;">Flexible</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>Bedrooms:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${bedrooms || '<em style="color: #999;">Any</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>Bathrooms:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${bathrooms || '<em style="color: #999;">Any</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>💰 Price Range:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${min_price ? "$" + min_price : "Any"} - ${max_price ? "$" + max_price : "Any"} per night
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;">
                <strong>Guests:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${guests || '<em style="color: #999;">Not specified</em>'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; vertical-align: top;">
                <strong>✨ Amenities:</strong>
              </td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">
                ${amenitiesText}
              </td>
            </tr>
          </table>
        </div>

        <!-- Action Button -->
        <div style="text-align: center; margin: 30px 0; padding: 20px 0;">
  
          <!-- Botón Reply -->
          <a href="mailto:${user_email}?subject=RE:Your Villa Search Request&body=Hi ${full_name},%0D%0A%0D%0AThank you for your interest in finding a luxury villa.%0D%0A%0D%0A" 
            style="
                display: inline-block;
                background-color: #000000;
                color: #ffffff;
                padding: 14px 32px;
                border-radius: 8px;
                text-decoration: none;
                font-weight: 600;
                font-size: 15px;
                margin-right: 10px;
                border: 1px solid #000000;
            ">
            Reply to ${full_name.split(" ")[0]}
          </a>

          <!-- Botón Dashboard -->
          <a href="https://thevillanet.com/admin" 
            style="
                display: inline-block;
                background-color: #000000;
                color: #ffffff;
                padding: 14px 32px;
                border-radius: 8px;
                text-decoration: none;
                font-weight: 600;
                font-size: 15px;
                border: 1px solid #000000;
            ">
            View in Dashboard
          </a>

        </div>

      <!-- Footer -->
      <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px; text-align: center; border-top: 1px solid #e0e0e0;">
        <p style="margin: 0; color: #999; font-size: 12px;">
          This request was submitted from <strong>VillaNet Properties</strong> page<br>
          ${new Date().toLocaleString("en-US", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: "America/New_York",
          })} (EST)
        </p>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"VillaNet" <noreply@villanet.com>',
      to: process.env.SMTP_USER, // Enviar al email del equipo
      subject: `New Villa Request from ${full_name}${location ? ` - ${location}` : ""}`,
      html: emailBody,
      // Reply-to para facilitar respuesta directa
      replyTo: user_email,
      attachments: [
    {
      filename: "logo.png",
      path: "./src/assets/logo-pdf.png",   
      cid: "logo@villanet",        
    },
  ],
    });

    console.log("📧 Expansion lead email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("❌ Error sending expansion lead email:", error);
    throw error;
  }
}

export async function sendVillaInquiryNotification(leadData) {
  const { full_name, user_email, whatsapp, listing_name, check_in, check_out, guests, message } = leadData

  const emailBody = `
    <div style="font-family: 'Helvetica', -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: white; padding: 30px 20px; text-align: center; border-bottom: 2px solid #e0e0e0;">
        <h1 style="color: #111827; margin: 0; font-size: 28px; font-weight: 700;">New Villa Inquiry</h1>
        <p style="color: #475569; margin: 10px 0 0 0; font-size: 16px;">St. Barts Villas</p>
      </div>

      <div style="padding: 30px 20px;">
        <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <h3 style="margin: 0 0 15px 0; color: #111827; font-size: 18px; font-weight: 600;">Contact Information</h3>
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; width: 100px;"><strong>Name:</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">${full_name}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;"><strong>Email:</strong></td>
              <td style="padding: 8px 0;">
                <a href="mailto:${user_email}" style="color: #111827; font-weight: 600;">${user_email}</a>
              </td>
            </tr>
            ${whatsapp ? `
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;"><strong>WhatsApp:</strong></td>
              <td style="padding: 8px 0;">
                <a href="https://wa.me/${whatsapp.replace(/\D/g,'')}" style="color: #25D366; font-weight: 600;">${whatsapp}</a>
              </td>
            </tr>` : ''}
          </table>
        </div>

        <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <h3 style="margin: 0 0 15px 0; color: #333; font-size: 16px; font-weight: 600; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px;">Villa & Dates</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; width: 120px;"><strong>Villa:</strong></td>
              <td style="padding: 8px 0; color: #333; font-size: 14px; font-weight: 600;">${listing_name || 'Not specified'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;"><strong>Check-in:</strong></td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">${check_in || '<em style="color:#999">Flexible</em>'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;"><strong>Check-out:</strong></td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">${check_out || '<em style="color:#999">Flexible</em>'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px;"><strong>Guests:</strong></td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">${guests || '<em style="color:#999">Not specified</em>'}</td>
            </tr>
            ${message ? `
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 14px; vertical-align: top;"><strong>Message:</strong></td>
              <td style="padding: 8px 0; color: #333; font-size: 14px;">${message}</td>
            </tr>` : ''}
          </table>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="mailto:${user_email}?subject=RE: Your St. Barts Villa Inquiry - ${listing_name}&body=Hi ${full_name.split(' ')[0]},%0D%0A%0D%0AThank you for your interest in ${listing_name}.%0D%0A%0D%0A"
            style="display: inline-block; background: #000; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
            Reply to ${full_name.split(' ')[0]}
          </a>
        </div>
      </div>

      <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
        <p style="margin: 0; color: #999; font-size: 12px;">
          Submitted from <strong>stbarts.thevillanet.com</strong><br>
          ${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/New_York' })} (EST)
        </p>
      </div>
    </div>
  `

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || '"St. Barts Villas" <noreply@thevillanet.com>',
    to: process.env.SMTP_USER,
    subject: `New Inquiry: ${listing_name || 'Villa'} — ${full_name}`,
    html: emailBody,
    replyTo: user_email,
  })

  console.log('📧 Villa inquiry email sent:', info.messageId)
  return { success: true, messageId: info.messageId }
}


/**
 * Verifica la configuración de email
 * @returns {Promise<boolean>}
 */
export async function verifyEmailConfig() {
  try {
    await transporter.verify();
    console.log("✅ Email transporter is ready");
    return true;
  } catch (error) {
    console.error("❌ Email transporter verification failed:", error);
    return false;
  }
}
