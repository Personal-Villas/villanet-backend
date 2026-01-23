export function buildGuestyUrl({ bookingDomain, propertyId, checkIn, checkOut, guests }) {
    const u = new URL(`https://${bookingDomain}/en/properties/${propertyId}`);
  
    if (guests) u.searchParams.set("minOccupancy", String(guests));
    if (checkIn) u.searchParams.set("checkIn", checkIn);   
    if (checkOut) u.searchParams.set("checkOut", checkOut);
  
    return u.toString();
  }
  