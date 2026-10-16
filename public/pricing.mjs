// Money is stored in integer cents. Percentages have two decimal places.
export function decimal(value, label = 'Αριθμός', max = 1000000) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`${label}: χρειάζεται μη αρνητικός αριθμός με έως 2 δεκαδικά.`);
  const number = Number(text);
  if (number > max) throw new Error(`${label}: υπερβαίνει το όριο ${max}.`);
  return Math.round(number * 100);
}
export function money(cents) { return (cents / 100).toFixed(2); }
function roundDivide(n, d) { return (n + d / 2n) / d; }
export function priceMultiplier(value) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(text) || Number(text) <= 0 || Number(text) > 100) throw new Error('Συντελεστής τιμής: βάλε αριθμό μεγαλύτερο από 0 και έως 100, με έως 4 δεκαδικά, π.χ. 1,55.');
  return Math.round(Number(text) * 10000);
}
export function validateRule(input) {
  if (typeof input.vendor !== 'string' || !input.vendor.trim() || input.vendor.length > 200) throw new Error('Χρειάζεται όνομα προμηθευτή.');
  if (typeof input.addVat !== 'boolean') throw new Error('Επίλεξε αν θα προστίθεται ΦΠΑ.');
  if (!['multiplier', 'margin'].includes(input.mode)) throw new Error('Επίλεξε τρόπο υπολογισμού τιμής.');
  const targetMargin = input.mode === 'margin' ? decimal(input.targetMargin, 'Στόχος μικτού περιθωρίου %', 100) : null;
  if (targetMargin !== null && targetMargin >= 10000) throw new Error('Το μικτό περιθώριο πρέπει να είναι μικρότερο από 100%.');
  return {
    mode: input.mode,
    targetMargin,
    fixed: input.fixed === '' ? 0 : decimal(input.fixed, 'Σταθερό ποσό €', 100000),
    vendor: input.vendor.trim(),
    multiplier: input.mode === 'multiplier' ? priceMultiplier(input.multiplier) : null,
    vat: decimal(input.vat, 'Συντελεστής ΦΠΑ', 100),
    addVat: input.addVat,
  };
}
export function calculate(cost, rule, taxable = true) {
  if (cost === null || cost === undefined) return { error: 'Λείπει το κόστος αγοράς στο Shopify.' };
  if (!rule) return { error: 'Λείπει ο κανόνας προμηθευτή.' };
  if (!Number.isSafeInteger(cost) || cost <= 0) return { error: 'Το κόστος αγοράς πρέπει να είναι μεγαλύτερο από μηδέν.' };
  // Keep the base-price ratio exact, including recurring margin divisions.
  const numerator = BigInt(cost) * BigInt(rule.mode === 'margin' ? 10000 : rule.multiplier);
  const denominator = BigInt(rule.mode === 'margin' ? 10000 - rule.targetMargin : 10000);
  const totalNumerator = (numerator + BigInt(rule.fixed) * denominator) * BigInt(rule.addVat ? 10000 + rule.vat : 10000);
  const totalDenominator = denominator * 10000n;
  // Round the exact price upward after VAT: €0.50 below €20, €1 otherwise.
  // Do not round to cents first: even a fraction of a cent must round upward.
  const step = totalNumerator < 2000n * totalDenominator ? 50n : 100n;
  const divisor = totalDenominator * step;
  const final = Number((totalNumerator + divisor - 1n) / divisor * step);
  const net = Number(roundDivide(BigInt(final) * 10000n, BigInt(taxable ? 10000 + rule.vat : 10000)));
  const profit = net - cost;
  return { final, net, profit, margin: net ? Math.round(profit / net * 10000) / 100 : 0 };
}
