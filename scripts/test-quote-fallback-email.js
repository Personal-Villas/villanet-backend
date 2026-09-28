// scripts/test-quote-fallback-email.js
// Uso: node scripts/test-quote-fallback-email.js
// Renderiza generateQuoteEmailHtml SIN taLogoUrl ni taName (header = logo fallback)
// y lo envía SOLO a nico_204@hotmail.com. Sin queries a DB.

import "dotenv/config";
import { sendEmail } from "../src/services/email.service.js";
import { generateQuoteEmailHtml } from "../src/controllers/quotes.controller.js";

const TO = "nico_204@hotmail.com";
const ICONS_DIR = "./src/assets/icons";

const quote = {
  recipient_type: "guest",
  guest_first_name: "Nico",
  guest_last_name: "Test",
  guests: 4,
};

const items = [
  {
    listing_name: "Sample Villa (fallback header test)",
    listing_location: "St. Barts",
    bedrooms: 4,
    bathrooms: 4,
    image_url: null,
    guestyUrl: "https://agents.personalvillas.com",
    breakdown: {
      base: 14000,
      cleaning: 500,
      feesTotal: 0,
      feeBreakdown: [],
      otherFees: 0,
      taxes: 800,
      total: 15300,
    },
  },
];

const iconAttachments = [
  { filename: "map-pin.png", path: `${ICONS_DIR}/map-pin.png`, cid: "map-pin@villanet" },
  { filename: "bed-double.png", path: `${ICONS_DIR}/bed-double.png`, cid: "bed-double@villanet" },
  { filename: "bath.png", path: `${ICONS_DIR}/bath.png`, cid: "bath@villanet" },
  { filename: "calendar-arrow-up.png", path: `${ICONS_DIR}/calendar-arrow-up.png`, cid: "calendar-arrow-up@villanet" },
  { filename: "calendar-arrow-down.png", path: `${ICONS_DIR}/calendar-arrow-down.png`, cid: "calendar-arrow-down@villanet" },
  { filename: "cloud-moon.png", path: `${ICONS_DIR}/cloud-moon.png`, cid: "cloud-moon@villanet" },
  { filename: "users.png", path: `${ICONS_DIR}/users.png`, cid: "users@villanet" },
  { filename: "square-check-big.png", path: `${ICONS_DIR}/square-check-big.png`, cid: "square-check-big@villanet" },
  { filename: "plane.png", path: `${ICONS_DIR}/plane.png`, cid: "plane@villanet" },
  { filename: "car.png", path: `${ICONS_DIR}/car.png`, cid: "car@villanet" },
  { filename: "shopping-cart.png", path: `${ICONS_DIR}/shopping-cart.png`, cid: "shopping-cart@villanet" },
  { filename: "chef-hat.png", path: `${ICONS_DIR}/chef-hat.png`, cid: "chef-hat@villanet" },
  { filename: "sparkles.png", path: `${ICONS_DIR}/sparkles.png`, cid: "sparkles@villanet" },
  { filename: "dumbbell.png", path: `${ICONS_DIR}/dumbbell.png`, cid: "dumbbell@villanet" },
  { filename: "baby.png", path: `${ICONS_DIR}/baby.png`, cid: "baby@villanet" },
  { filename: "party-popper.png", path: `${ICONS_DIR}/party-popper.png`, cid: "party-popper@villanet" },
];

async function main() {
  console.log("Renderizando quote SIN taLogoUrl / taName (fallback logo)…");
  const html = await generateQuoteEmailHtml(
    quote,
    items,
    7,                 // nights
    "2026-12-01",      // checkInYmd
    "2026-12-08",      // checkOutYmd
    null,              // pmLogoUrl
    "villanet",        // pmName (unused in template)
    null,              // taLogoUrl → fuerza fallback
    null,              // taName → fuerza fallback
    null,              // taFirstName
    "USD",
  );

  console.log(`Enviando SOLO a ${TO}…`);
  await sendEmail({
    to: TO,
    subject: "[TEST] Quote email — fallback header (Personal Villas Agents)",
    html,
    attachments: iconAttachments,
  });
  console.log("Listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
