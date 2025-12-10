// services/cartPdf.service.js
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLORS = {
  accent: '#E9B876',
  accentDark: '#D4A05E',
  dark: '#203F3C',
  grayLight: '#F7F7F7',
  text: '#2C2C2C',
  textLight: '#7A7A7A',
  divider: '#E0E0E0',
  white: '#FFFFFF',
  shadow: 'rgba(0, 0, 0, 0.08)',
};

/**
 * Descarga una imagen desde una URL con timeout y manejo de errores
 */
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => {
      reject(new Error('Image download timeout'));
    }, 8000); // Aumentado a 8 segundos

    protocol.get(url, (response) => {
      clearTimeout(timeout);
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: ${response.statusCode}`));
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Genera un PDF estilizado con imágenes de villas
 */
export function generateCartPdf(listings, { clientName }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        margin: 0,
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const margin = 50;
      const logoPath = path.join(__dirname, '../assets/logo.png');

      // ============ FUNCIÓN PARA DIBUJAR HEADER MEJORADO ============
      function drawHeader(yPosition = 35) {
        try {
          if (fs.existsSync(logoPath)) {
            doc.image(logoPath, margin, yPosition, { width: 80 });
          } else {
            // Logo tipográfico elegante
            doc
              .fontSize(18)
              .fillColor(COLORS.accent)
              .font('Helvetica-Bold')
              .text('VILLA', margin, yPosition + 3, { continued: true })
              .fillColor(COLORS.dark)
              .text('NET');
          }
        } catch (error) {
          doc
            .fontSize(18)
            .fillColor(COLORS.accent)
            .font('Helvetica-Bold')
            .text('VILLA', margin, yPosition + 3, { continued: true })
            .fillColor(COLORS.dark)
            .text('NET');
        }

        // Línea decorativa con gradiente simulado
        const lineY = yPosition + 58;
        doc
          .moveTo(margin, lineY)
          .lineTo(pageWidth - margin, lineY)
          .strokeColor(COLORS.accent)
          .lineWidth(2.5)
          .stroke();
        
        return lineY + 45;
      }

      // ============ PRIMERA PÁGINA - PORTADA MEJORADA ============
      const startY = drawHeader();
      doc.y = startY;

      // Título principal con mejor espaciado
      doc
        .fontSize(42)
        .font('Helvetica-Bold')
        .fillColor(COLORS.dark)
        .text('Villa Selection', margin, doc.y, {
          width: pageWidth - margin * 2,
          align: 'center',
          characterSpacing: 0.5
        });

      doc.y += 18;

      // Subtítulo
      doc
        .fontSize(14)
        .font('Helvetica')
        .fillColor(COLORS.textLight)
        .text('Curated for Your Perfect Getaway', margin, doc.y, {
          width: pageWidth - margin * 2,
          align: 'center'
        });

      doc.y += 60;

      // Información del cliente con caja decorativa
      if (clientName) {
        const boxY = doc.y;
        const boxHeight = 80;
        
        // Caja con sombra simulada
        doc
          .roundedRect(margin + 3, boxY + 3, pageWidth - margin * 2, boxHeight, 8)
          .fillColor('#E8E8E8')
          .fill();
        
        doc
          .roundedRect(margin, boxY, pageWidth - margin * 2, boxHeight, 8)
          .fillColor(COLORS.grayLight)
          .fill();

        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor(COLORS.textLight)
          .text('PREPARED FOR', margin + 30, boxY + 20);
        
        doc
          .fontSize(16)
          .font('Helvetica-Bold')
          .fillColor(COLORS.accent)
          .text(clientName, margin + 30, boxY + 42);
        
        doc.y = boxY + boxHeight + 45;
      } else {
        doc.y += 25;
      }

      // Descripción con mejor formato
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor(COLORS.text)
        .text(
          'This document presents a carefully curated selection of luxury villas. Each property has been chosen to match your preferences and lifestyle requirements.',
          margin,
          doc.y,
          {
            width: pageWidth - margin * 2,
            align: 'left',
            lineGap: 3
          }
        );

      doc.y += 20;

      doc
        .fontSize(9)
        .fillColor(COLORS.textLight)
        .text(
          'Please contact your travel advisor for availability, detailed information, and final pricing.',
          margin,
          doc.y,
          {
            width: pageWidth - margin * 2,
            align: 'left'
          }
        );

      doc.y += 65;

      // ============ VILLAS CON DISEÑO MEJORADO ============
      for (let index = 0; index < listings.length; index++) {
        const villa = listings[index];
        
        const cardHeight = 210;
        const imageWidth = 270;
        const imageHeight = cardHeight - 30;
        
        // Verificar si necesitamos nueva página
        if (doc.y > pageHeight - cardHeight - 90) {
          doc.addPage();
          doc.y = drawHeader();
        }

        const cardY = doc.y;
        const cardX = margin;
        const cardWidth = pageWidth - margin * 2;

        // Sombra de la card
        doc
          .roundedRect(cardX + 2, cardY + 2, cardWidth, cardHeight, 10)
          .fillColor('#E8E8E8')
          .fill();

        // Fondo de la card
        doc
          .roundedRect(cardX, cardY, cardWidth, cardHeight, 10)
          .lineWidth(0.5)
          .strokeColor(COLORS.divider)
          .fillAndStroke(COLORS.white, COLORS.divider);

        // ============ IMAGEN CON MEJOR MANEJO ============
        const imgX = cardX + 15;
        const imgY = cardY + 15;
        
        let imageLoaded = false;
        
        if (villa.imageUrl) {
          try {
            const imageBuffer = await downloadImage(villa.imageUrl);
            doc.save();
            doc.roundedRect(imgX, imgY, imageWidth, imageHeight, 8).clip();
            doc.image(imageBuffer, imgX, imgY, {
              width: imageWidth,
              height: imageHeight,
              fit: [imageWidth, imageHeight],
              align: 'center',
              valign: 'center'
            });
            doc.restore();
            imageLoaded = true;
          } catch (error) {
            console.warn(`⚠️ Could not load image for ${villa.name}:`, error.message);
          }
        }

        if (!imageLoaded) {
          // Placeholder mejorado con gradiente simulado
          doc
            .roundedRect(imgX, imgY, imageWidth, imageHeight, 8)
            .fillColor('#F0F0F0')
            .fill();
          
          doc
            .roundedRect(imgX, imgY, imageWidth, imageHeight, 8)
            .lineWidth(1.5)
            .strokeColor(COLORS.divider)
            .stroke();
          
          // Ícono de casa
          doc
            .fontSize(65)
            .fillColor(COLORS.textLight)
            .text('🏡', imgX, imgY + (imageHeight / 2) - 42, {
              width: imageWidth,
              align: 'center'
            });
          
          doc
            .fontSize(9)
            .fillColor(COLORS.textLight)
            .text('Image not available', imgX, imgY + (imageHeight / 2) + 30, {
              width: imageWidth,
              align: 'center'
            });
        }

        // ============ CONTENIDO A LA DERECHA MEJORADO ============
        const contentX = cardX + imageWidth + 40;
        const contentWidth = cardWidth - imageWidth - 55;
        let currentY = cardY + 22;

        // Badge de número con sombra
        const badgeSize = 38;
        doc
          .roundedRect(contentX + 1, currentY + 1, badgeSize, badgeSize, 6)
          .fillColor('#D0D0D0')
          .fill();
        
        doc
          .roundedRect(contentX, currentY, badgeSize, badgeSize, 6)
          .fill(COLORS.accent);

        doc
          .fontSize(20)
          .font('Helvetica-Bold')
          .fillColor(COLORS.white)
          .text((index + 1).toString(), contentX, currentY + 8, {
            width: badgeSize,
            align: 'center'
          });

        currentY += 53;

        // Nombre de la villa con límite de altura
        const villaName = villa.name || 'Unnamed Villa';
        doc
          .fontSize(16)
          .font('Helvetica-Bold')
          .fillColor(COLORS.dark);
        
        const nameHeight = doc.heightOfString(villaName, {
          width: contentWidth
        });
        
        doc.text(villaName, contentX, currentY, {
          width: contentWidth,
          height: 42,
          ellipsis: true
        });

        currentY += Math.min(nameHeight, 42) + 10;

        // Ubicación con bullet point
        if (villa.location) {
          doc
            .fontSize(10)
            .font('Helvetica')
            .fillColor(COLORS.textLight)
            .text('• ', contentX, currentY, { continued: true })
            .fillColor(COLORS.text)
            .text(villa.location, {
              width: contentWidth - 10,
              ellipsis: true
            });
          
          currentY += 22;
        }

        // Bedrooms & Bathrooms mejorado
        const beds = villa.bedrooms ?? '—';
        const baths = villa.bathrooms ?? '—';
        
        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor(COLORS.dark)
          .text(beds, contentX, currentY, { continued: true })
          .font('Helvetica')
          .fillColor(COLORS.text)
          .text(' Bedrooms  ', { continued: true })
          .fillColor(COLORS.divider)
          .text('•', { continued: true })
          .fillColor(COLORS.text)
          .text('  ', { continued: true })
          .font('Helvetica-Bold')
          .fillColor(COLORS.dark)
          .text(baths, { continued: true })
          .font('Helvetica')
          .fillColor(COLORS.text)
          .text(' Bathrooms');
        
        currentY += 28;

        // Precio con mejor formato
        if (villa.priceUSD != null) {
          const amount = Number(villa.priceUSD);
          if (!isNaN(amount)) {
            const formatted = `$${(amount / 100).toLocaleString('en-US', { 
              minimumFractionDigits: 0,
              maximumFractionDigits: 0 
            })}`;
            
            doc
              .fontSize(9)
              .font('Helvetica')
              .fillColor(COLORS.textLight)
              .text('Starting from  ', contentX, currentY, { continued: true })
              .fontSize(18)
              .font('Helvetica-Bold')
              .fillColor(COLORS.accent)
              .text(formatted, { continued: true })
              .fontSize(9)
              .font('Helvetica')
              .fillColor(COLORS.textLight)
              .text('  / night');
          }
        }

        // Siguiente card con más espacio
        doc.y = cardY + cardHeight + 35;
      }

      // Mensaje si no hay villas
      if (!listings.length) {
        doc
          .fontSize(12)
          .fillColor(COLORS.textLight)
          .text('No villas were included in this selection.', margin, doc.y + 50, {
            width: pageWidth - margin * 2,
            align: 'center',
          });
      }

      // ============ FOOTER MEJORADO EN TODAS LAS PÁGINAS ============
      const pageCount = doc.bufferedPageRange().count;
      
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        
        const footerY = pageHeight - 55;
        
        // Línea superior del footer
        doc
          .moveTo(margin, footerY)
          .lineTo(pageWidth - margin, footerY)
          .strokeColor(COLORS.accent)
          .lineWidth(1.8)
          .stroke();

        // Información de contacto
        doc
          .fontSize(9)
          .font('Helvetica-Bold')
          .fillColor(COLORS.dark)
          .text('VillaNet', margin, footerY + 14, {
            width: pageWidth - margin * 2,
            align: 'center',
          });

        doc
          .fontSize(8.5)
          .font('Helvetica')
          .fillColor(COLORS.textLight)
          .text('Luxury Villa Rentals  •  contact@villanet.com', margin, footerY + 28, {
            width: pageWidth - margin * 2,
            align: 'center',
          });

        // Número de página
        doc
          .fontSize(8)
          .fillColor(COLORS.textLight)
          .text(`Page ${i + 1} of ${pageCount}`, pageWidth - margin - 60, footerY + 14);
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}