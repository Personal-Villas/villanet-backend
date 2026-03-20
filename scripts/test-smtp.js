// test-smtp.js
// Uso: node test-smtp.js [destinatario@ejemplo.com]
// Testea la conexión SMTP y envía un correo de prueba usando las variables de entorno de VillaNet.

import "dotenv/config";
import nodemailer from "nodemailer";

const recipient = process.argv[2] || process.env.SMTP_USER;

async function testSMTP() {
  console.log("=== VillaNet SMTP Test ===\n");
  console.log("Configuración detectada:");
  console.log(`  SMTP_HOST : ${process.env.SMTP_HOST}`);
  console.log(`  SMTP_PORT : ${process.env.SMTP_PORT}`);
  console.log(`  SMTP_USER : ${process.env.SMTP_USER}`);
  console.log(`  SMTP_FROM : ${process.env.SMTP_FROM}`);
  console.log(`  Destinatario de prueba: ${recipient}\n`);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false, // false = STARTTLS en puerto 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // AC2: Verificar autenticación
  console.log("[ AC2 ] Verificando autenticación con el servidor SMTP...");
  try {
    await transporter.verify();
    console.log("  ✅ Autenticación exitosa. El servidor aceptó las credenciales.\n");
  } catch (err) {
    console.error("  ❌ Error de autenticación:");
    console.error(`     ${err.message}\n`);
    console.error("  ⚠️  PLAN DE CONTINGENCIA:");
    console.error("     La cuenta probablemente tiene 2FA activo.");
    console.error("     Solicitar a Jhony que gestione con Robbie una App Password");
    console.error("     (clave de 16 caracteres) desde myaccount.google.com/apppasswords");
    console.error("     y actualizar SMTP_PASS en el .env.\n");
    process.exit(1);
  }

  // AC3 + AC4: Enviar correo de prueba
  console.log("[ AC4 ] Enviando correo de prueba...");
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM, // AC3: "Villanet <info@thevillanet.com>"
      to: recipient,
      subject: "VillaNet — Test SMTP ✅",
      text: "Este es un correo de prueba enviado desde el backend de VillaNet para verificar la configuración SMTP.",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
          <h2 style="color: #1a1a1a;">VillaNet — Test SMTP</h2>
          <p>Este correo confirma que la configuración SMTP está funcionando correctamente.</p>
          <ul>
            <li><strong>Host:</strong> ${process.env.SMTP_HOST}</li>
            <li><strong>Puerto:</strong> ${process.env.SMTP_PORT}</li>
            <li><strong>Remitente:</strong> ${process.env.SMTP_FROM}</li>
          </ul>
          <p style="color: #888; font-size: 12px;">Enviado automáticamente por test-smtp.js</p>
        </div>
      `,
    });

    console.log("  ✅ Correo enviado exitosamente.");
    console.log(`     Message ID : ${info.messageId}`);
    console.log(`     Destinatario: ${recipient}`);
    console.log("\n=== Test completado. Verificá la bandeja de entrada (y Spam). ===");
  } catch (err) {
    console.error("  ❌ Error al enviar el correo:");
    console.error(`     ${err.message}`);
    process.exit(1);
  }
}

testSMTP();