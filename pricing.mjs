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
  return {
    vendor: input.vendor.trim(),
    multiplier: priceMultiplier(input.multiplier),
    vat: decimal(input.vat, 'Συντελεστής ΦΠΑ', 100),
    addVat: input.addVat,
  };
}
export function calculate(cost, rule, taxable = true) {
  if (cost === null || cost === undefined) return { error: 'Λείπει το κόστος αγοράς στο Shopify.' };
  if (!rule) return { error: 'Λείπει ο κανόνας προμηθευτή.' };
  if (!Number.isSafeInteger(cost) || cost <= 0) return { error: 'Το κόστος αγοράς πρέπει να είναι μεγαλύτερο από μηδέν.' };
  // Purchase cost × multiplier × optional VAT. Round only the final amount.
  const beforeTax = BigInt(cost) * BigInt(rule.multiplier);
  const final = Number(roundDivide(beforeTax * BigInt(rule.addVat ? 10000 + rule.vat : 10000), 100000000n));
  const net = Number(roundDivide(BigInt(final) * 10000n, BigInt(taxable ? 10000 + rule.vat : 10000)));
  const profit = net - cost;
  return { final, net, profit, margin: net ? Math.round(profit / net * 10000) / 100 : 0 };
}
