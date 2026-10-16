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
  if (!Array.isArray(input.conditions) || input.conditions.length > 50) throw new Error('Μπορείς να προσθέσεις έως 50 όρους ανά brand.');
  const conditions = input.conditions.map((condition, i) => {
    if (!condition || typeof condition !== 'object') throw new Error(`Όρος ${i + 1}: μη έγκυρα στοιχεία.`);
    const from = decimal(condition.from, `Όρος ${i + 1}: από €`);
    const to = decimal(condition.to, `Όρος ${i + 1}: μέχρι €`);
    const amount = decimal(condition.amount, `Όρος ${i + 1}: ποσό €`, 100000);
    if (from > to) throw new Error(`Όρος ${i + 1}: το «από» πρέπει να είναι μικρότερο ή ίσο με το «μέχρι».`);
    if (typeof condition.collectionId !== 'string' || (condition.collectionId !== '' && !/^gid:\/\/shopify\/Collection\/\d+$/.test(condition.collectionId))) throw new Error(`Όρος ${i + 1}: επίλεξε collection ή «Όλα».`);
    return { from, to, amount, collectionId: condition.collectionId };
  });
  return {
    conditions,
    mode: input.mode,
    targetMargin,
    vendor: input.vendor.trim(),
    multiplier: input.mode === 'multiplier' ? priceMultiplier(input.multiplier) : null,
    vat: decimal(input.vat, 'Συντελεστής ΦΠΑ', 100),
    addVat: input.addVat,
  };
}
function roundedPrice(numerator, denominator) {
  const step = numerator < 2000n * denominator ? 50n : 100n;
  const divisor = denominator * step;
  return Number((numerator + divisor - 1n) / divisor * step);
}
export function calculate(cost, rule, taxable = true, collectionIds = null) {
  if (cost === null || cost === undefined) return { error: 'Λείπει το κόστος αγοράς στο Shopify.' };
  if (!rule) return { error: 'Λείπει ο κανόνας προμηθευτή.' };
  if (!Number.isSafeInteger(cost) || cost <= 0) return { error: 'Το κόστος αγοράς πρέπει να είναι μεγαλύτερο από μηδέν.' };
  // Keep the base-price ratio exact, including recurring margin divisions.
  const numerator = BigInt(cost) * BigInt(rule.mode === 'margin' ? 10000 : rule.multiplier);
  const denominator = BigInt(rule.mode === 'margin' ? 10000 - rule.targetMargin : 10000);
  const vatFactor = BigInt(rule.addVat ? 10000 + rule.vat : 10000);
  const baseNumerator = numerator * vatFactor;
  const totalDenominator = denominator * 10000n;
  // Every condition sees the same rounded base sale price. Additions cannot
  // trigger another condition, regardless of row order. Bounds are inclusive.
  const referencePrice = roundedPrice(baseNumerator, totalDenominator);
  const priceConditions = rule.conditions.filter(c => referencePrice >= c.from && referencePrice <= c.to);
  const requiresCollections = priceConditions.some(c => c.collectionId);
  if (requiresCollections && !Array.isArray(collectionIds)) return { error: 'Κάνε συγχρονισμό Shopify για τα collections πριν υπολογιστούν οι όροι.' };
  const fixed = priceConditions.filter(c => !c.collectionId || collectionIds.includes(c.collectionId)).reduce((sum, c) => sum + c.amount, 0);
  const final = roundedPrice((numerator + BigInt(fixed) * denominator) * vatFactor, totalDenominator);
  const net = Number(roundDivide(BigInt(final) * 10000n, BigInt(taxable ? 10000 + rule.vat : 10000)));
  const profit = net - cost;
  return { final, net, profit, margin: net ? Math.round(profit / net * 10000) / 100 : 0, fixed, referencePrice, requiresCollections };
}
