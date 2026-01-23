async function mapLimit(arr, limit, fn) {
    const ret = [];
    const executing = [];
    for (const item of arr) {
      const p = Promise.resolve().then(() => fn(item));
      ret.push(p);
  
      if (limit <= arr.length) {
        const e = p.then(() => executing.splice(executing.indexOf(e), 1));
        executing.push(e);
        if (executing.length >= limit) await Promise.race(executing);
      }
    }
    return Promise.all(ret);
  }
  
  /**
   * Batch: retorna array con { listingId, available, reason? }
   */
  export async function checkGuestyAvailabilityBatch({ checkIn, checkOut, guests, items }) {
    const limit = 5;
  
    const results = await mapLimit(items, limit, async (it) => {
      try {
        const r = await checkOneGuestyAvailability({
          listingId: it.id,
          guestyBookingDomain: it.guestyBookingDomain,
          checkIn,
          checkOut,
          guests,
        });
  
        // r.available: true/false
        return { listingId: it.id, available: !!r.available, reason: r.reason };
      } catch (e) {
        // unknown si falló
        return { listingId: it.id, available: null, reason: e.message };
      }
    });
  
    return results;
  }
  
  /**
   * IMPLEMENTAR: acá enchufás tu “fuente de verdad”
   * - Guesty API (ideal)
   * - tu propio availability cache/session si ya lo tenés
   */
  async function checkOneGuestyAvailability({ listingId, guestyBookingDomain, checkIn, checkOut, guests }) {
    // ✅ RECOMENDADO: si ya tenés un endpoint interno que consulta availability, úsalo acá
    // Por ahora, dejamos un placeholder claro:
  
    // EJEMPLO de respuesta esperada:
    // return { available: true }   o  { available: false, reason: 'booked' }
  
    // ⚠️ IMPORTANTE:
    // No recomiendo “scrapear” guestybookings.com ni pegarle al front URL
    // porque suele variar y tiene protecciones.
  
    throw new Error('checkOneGuestyAvailability() no implementado');
  }