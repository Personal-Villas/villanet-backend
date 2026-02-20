import { guestyOA } from "./guestyOpenApiClient.js";

export async function createOpenAPIQuote({
  listingId,
  checkIn,
  checkOut,
  guestsCount = 1,
  source = "manual", 
  bookingDomain,  
}) {
  console.log("🚀 CREATE OPEN API QUOTE", { listingId, checkIn, checkOut, guestsCount, source });

  const payload = {
    listingId: String(listingId),
    checkInDateLocalized: checkIn,
    checkOutDateLocalized: checkOut,
    guestsCount: Number(guestsCount), 
    source,
  };

  try {
    const response = await guestyOA.post("/quotes", payload);

    const data = response.data;
    if (!data || !data.rates?.ratePlans?.[0]?.money) {
      throw new Error("Respuesta sin money o ratePlans");
    }

    const moneyWrapper = data.rates.ratePlans[0].money;
    const money = moneyWrapper.money;
    const baseRate = money.fareAccommodation || 0;
    if (baseRate === 0 && money.totalFees === 0 && money.totalTaxes === 0) {
        console.warn("⚠️ [OpenAPI] Quote devolvió todo en 0 para:", {
          listingId, checkIn, checkOut, guestsCount
        });
        console.warn("   Causas posibles: fechas bloqueadas, min nights no cumplido, min occupancy");
        throw new Error(`QUOTE_EMPTY: Guesty devolvió precios en 0 para ${listingId} (${checkIn}→${checkOut})`);
      }
    const totalFees = money.totalFees || 0;
    const subtotalBeforeTaxes = money.subTotalPrice || (baseRate + totalFees);
    const taxes = money.totalTaxes || 0;
    const grandTotal = money.hostPayout || (subtotalBeforeTaxes + taxes);

    const invoiceItems = money.invoiceItems || [];

    console.log("✅ OpenAPI Quote OK", {
      baseRate,
      totalFees,
      taxes,
      grandTotal,
      invoiceItemsCount: invoiceItems.length,
    });

    return {
      ...data,
      calculated: {
        baseRate,
        totalFees,
        subtotalBeforeTaxes,
        taxes,
        grandTotal,
        invoiceItems,
        source: "open-api",
      },
    };
  } catch (e) {
    console.error("❌ createOpenAPIQuote falló:", e.message, e.response?.data || e);
    throw e;
  }
}