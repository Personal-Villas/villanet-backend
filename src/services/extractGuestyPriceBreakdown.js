function normType(x) {
  return String(x?.secondIdentifier || x?.normalType || x?.type || x?.code || "")
    .trim()
    .toUpperCase();
}

function normTitle(x) {
  return String(x?.title || x?.name || x?.description || x?.label || "").trim();
}

function amount(x) {
  const n = Number(x?.amount ?? x?.total ?? x?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isTax(x) {
  const t = normType(x);
  const title = normTitle(x).toLowerCase();
  return (
    x?.isTax === true ||
    t === "TAX" ||
    t === "LT" ||
    t.includes("TAX") ||
    title.includes("tax")
  );
}

function isBase(x) {
  const t = normType(x);
  const title = normTitle(x).toLowerCase();
  return (
    t === "AF" ||
    t.includes("ACCOMMODATION") ||
    title.includes("accommodation") ||
    title.includes("base rate")
  );
}

function isCleaning(x) {
  const t = normType(x);
  const title = normTitle(x).toLowerCase();
  return t === "CF" || title.includes("cleaning");
}

export function extractGuestyPriceBreakdown(quoteData) {
  const money =
    quoteData?.rates?.ratePlans?.[0]?.money?.money ||
    quoteData?.rates?.ratePlans?.[0]?.money ||
    quoteData?.money ||
    {};

  const invoiceItems = money.invoiceItems || [];

  const base = invoiceItems
    .filter(it => {
      const t = (it.type || it.normalType || "").toUpperCase();
      return t.includes("ACCOMMODATION") || t === "AF";
    })
    .reduce((s, x) => s + Number(x.amount || 0), 0);

  const taxes = invoiceItems
    .filter(it => it.isTax || (it.type || "").toUpperCase().includes("TAX"))
    .reduce((s, x) => s + Number(x.amount || 0), 0);

  const feeBreakdown = invoiceItems
    .filter(it => {
      const t = (it.type || it.normalType || "").toUpperCase();
      return (
        !t.includes("ACCOMMODATION") &&
        !t.includes("TAX") &&
        !it.isTax &&
        Number(it.amount || 0) > 0
      );
    })
    .map(it => ({
      title: it.title || it.name || "Fee",
      amount: Number(it.amount || 0),
      type: it.type || it.normalType || "OTHER",
    }));

  const feesTotal = feeBreakdown.reduce((s, f) => s + f.amount, 0);

  // Prioridad para el total:
  // 1. invoiceTotal / faresTotalAmount — total exacto del checkout que ve el cliente
  // 2. Suma de todos los invoice items (sin redondeos intermedios)
  // 3. hostPayout / money.total como último recurso (pueden diferir por redondeos)
  const invoiceItemsSum = invoiceItems.reduce((s, x) => s + Number(x.amount || 0), 0);

  const rawTotal =
    Number(money.invoiceTotal) ||
    Number(money.faresTotalAmount) ||
    Number(money.totalAmount) ||
    (invoiceItemsSum > 0 ? invoiceItemsSum : null) ||
    Number(money.total) ||
    Number(money.hostPayout) ||
    Number(quoteData?.total) ||
    (base + feesTotal + taxes);

  // Guesty redondea hacia arriba en su UI — aplicamos el mismo criterio
  const total = Math.round(rawTotal);

  return {
    currency: money.currency || invoiceItems[0]?.currency || "USD",
    base,
    taxes,
    feeBreakdown,
    feesTotal,
    total,
    invoiceItems,
  };
}