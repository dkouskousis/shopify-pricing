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
export function validateRule(input) {
  if (typeof input.vendor !== 'string' || !input.vendor.trim() || input.vendor.length > 200) throw new Error('Χρειάζεται όνομα προμηθευτή.');
  if (typeof input.addVat !== 'boolean') throw new Error('Επίλεξε αν θα προστίθεται ΦΠΑ.');
  return {
    vendor: input.vendor.trim(),
    markup: decimal(input.markup, 'Προσαύξηση %', 1000),
    fixed: decimal(input.fixed, 'Σταθερό ποσό', 100000),
    vat: decimal(input.vat, 'Συντελεστής ΦΠΑ', 100),
    addVat: input.addVat,
  };
}
export function calculate(cost, rule, extra = 0, taxable = true) {
  if (cost === null || cost === undefined) return { error: 'Λείπει το κόστος αγοράς στο Shopify.' };
  if (!rule) return { error: 'Λείπει ο κανόνας προμηθευτή.' };
  if (!Number.isSafeInteger(cost) || cost <= 0) return { error: 'Το κόστος αγοράς πρέπει να είναι μεγαλύτερο από μηδέν.' };
  // Round only the final result, rather than rounding intermediate markup/VAT.
  const beforeTax = BigInt(cost) * BigInt(10000 + rule.markup) + BigInt(rule.fixed + extra) * 10000n;
  const final = Number(roundDivide(beforeTax * BigInt(rule.addVat ? 10000 + rule.vat : 10000), 100000000n));
  const net = Number(roundDivide(BigInt(final) * 10000n, BigInt(taxable ? 10000 + rule.vat : 10000)));
  const profit = net - cost - extra;
  return { final, net, profit, margin: net ? Math.round(profit / net * 10000) / 100 : 0 };
}
