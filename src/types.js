export const Roles = {
  ADMIN: "admin",
  TA: "ta",
  PMC: "pmc",
};

export const Status = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
};

// Estados específicos para expansion leads
export const ExpansionLeadStatus = {
  PENDING: "pending", // Lead recibido, sin contactar
  CONTACTED: "contacted", // Ya se contactó al cliente
  CONVERTED: "converted", // Se concretó una reserva
  EXPIRED: "expired", // Lead expirado sin conversión
};

// Fuentes de leads
export const LeadSource = {
  WEB: "web",
  MOBILE: "mobile",
  API: "api",
};
