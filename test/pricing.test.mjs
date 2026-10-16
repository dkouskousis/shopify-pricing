import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, calculate, validateRule, priceMultiplier } from '../pricing.mjs';
const rule = (addVat = true) => validateRule({ vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.55', vat: '24', addVat });
test('upward rounding respects half-euro steps, the €20 boundary and exact prices', () => {
  const identity = validateRule({ vendor: 'Test', conditions: [], mode: 'multiplier', multiplier: '1', vat: '0', addVat: false });
  for (const [cost, final] of [[1, 50], [812, 850], [850, 850], [851, 900], [1950, 1950], [1951, 2000], [1999, 2000], [2000, 2000], [2001, 2100], [2050, 2100], [12435, 12500], [12500, 12500]]) {
    assert.equal(calculate(cost, identity, false).final, final);
  }
  // Less than half a cent above a valid ending still rounds upward.
  assert.equal(calculate(850, { ...identity, multiplier: 10001 }, false).final, 900);
  assert.equal(calculate(2000, { ...identity, multiplier: 10001 }, false).final, 2100);
  // The threshold applies after fixed amount and VAT, not to the purchase cost.
  assert.equal(calculate(1650, { ...identity, addVat: true, vat: 2400 }).final, 2100);
  assert.equal(calculate(1950, { ...identity, conditions: [{ from: 0, to: 10000, amount: 100, collectionId: '' }] }, false).final, 2100);
});
test('simple formula: purchase cost × entered multiplier × optional VAT', () => {
  assert.equal(calculate(6000, rule()).final, 11600);
  assert.equal(calculate(6000, rule(false)).final, 9300);
  assert.equal(calculate(6000, validateRule({ vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '2', vat: '24', addVat: true })).final, 14900);
});
test('disabling VAT addition does not imply tax exemption on sales', () => {
  assert.equal(calculate(6000, rule(false)).net, 7500);
  assert.equal(calculate(6000, rule(false), false).net, 9300);
});
test('upward price rounding preserves exact multiplier conversion', () => {
  assert.equal(calculate(1, validateRule({ vendor: 'Test', conditions: [], mode: 'multiplier', multiplier: '1.5', vat: '24', addVat: true })).final, 50);
  assert.equal(calculate(6000, validateRule({ vendor: 'Test', conditions: [], mode: 'multiplier', multiplier: '1.5457', vat: '24', addVat: true })).final, 11600);
  assert.equal(priceMultiplier('1,55'), 15500);
  assert.equal(decimal('12,50'), 1250);
});
test('missing and invalid input never silently becomes zero', () => {
  assert.match(calculate(null, rule()).error, /Λείπει/);
  assert.match(calculate(6000, null).error, /Λείπει/);
  assert.match(calculate(0, rule()).error, /μηδέν/);
  for (const input of ['', '-1', 'NaN', 'Infinity', '1.234', '1e4']) assert.throws(() => decimal(input));
  for (const input of ['', '0', '-1', '101', '1.23456', 'Infinity']) assert.throws(() => priceMultiplier(input));
});

test('gross profit and gross margin are based on the proposed net selling price', () => {
  const result = calculate(12395, validateRule({ vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(result.final, 21600);
  assert.equal(result.profit, 5024);
  assert.equal(result.margin, 28.84);
});
test('margin mode targets net sales margin instead of purchase markup', () => {
  const rule = validateRule({ vendor: 'Example', conditions: [], mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
  const result = calculate(6000, rule);
  assert.equal(rule.multiplier, null);
  assert.equal(result.final, 12400);
  assert.equal(result.net, 10000);
  assert.equal(result.profit, 4000);
  assert.equal(result.margin, 40);
  const markedUp = calculate(6000, validateRule({ vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(markedUp.final, 10500);
  assert.equal(markedUp.margin, 29.15);
});
test('margin mode preserves optional VAT behavior and distinguishes taxable sales', () => {
  const rule = validateRule({ vendor: 'Example', conditions: [], mode: 'margin', targetMargin: '40', vat: '24', addVat: false });
  assert.equal(calculate(6000, rule).final, 10000);
  assert.equal(calculate(6000, rule).margin, 25.6);
  assert.equal(calculate(6000, rule, false).margin, 40);
});
test('margin validation accepts zero and decimals, rejects 100% and malformed inputs', () => {
  const input = { vendor: 'Example', conditions: [], mode: 'margin', vat: '24', addVat: true };
  assert.equal(calculate(6000, validateRule({ ...input, targetMargin: '0' })).final, 7500);
  assert.equal(validateRule({ ...input, targetMargin: '33,33' }).targetMargin, 3333);
  assert.equal(calculate(1, validateRule({ ...input, targetMargin: '99.99' })).final, 12400);
  for (const targetMargin of ['', '100', '101', '-1', '20.123', 'Infinity']) assert.throws(() => validateRule({ ...input, targetMargin }));
  assert.throws(() => validateRule({ ...input, mode: 'unknown', targetMargin: '40' }));
});
test('fixed addition comes after multiplication and before optional VAT', () => {
  const input = { vendor: 'Example', conditions: [{ from: '0', to: '1000', amount: '10', collectionId: '' }], mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true };
  const result = calculate(6000, validateRule(input));
  assert.equal(result.final, 11700);
  assert.equal(result.net, 9435);
  assert.equal(result.profit, 3435);
  assert.equal(calculate(6000, validateRule({ ...input, addVat: false })).final, 9400);
  assert.equal(calculate(6000, validateRule({ ...input, conditions: [] })).final, 10500);
});
test('fixed addition applies after the base margin price and updates actual gross margin', () => {
  const rule = validateRule({ vendor: 'Example', conditions: [{ from: '0', to: '1000', amount: '10', collectionId: '' }], mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
  const result = calculate(6000, rule);
  assert.equal(result.final, 13700);
  assert.equal(result.profit, 5048);
  assert.equal(result.margin, 45.69);
});

test('conditions use one rounded reference price, sum overlaps and never cascade', () => {
  const conditions = [
    { from: '0', to: '50', amount: '2', collectionId: '' },
    { from: '50', to: '60', amount: '3', collectionId: '' },
    { from: '55', to: '100', amount: '10', collectionId: '' },
  ];
  const r = validateRule({ vendor: 'Test', mode: 'multiplier', multiplier: '1', vat: '24', addVat: false, conditions });
  assert.equal(calculate(4950, r).referencePrice, 5000);
  assert.equal(calculate(4950, r).fixed, 500);
  assert.equal(calculate(4950, r).final, 5500);
  assert.equal(calculate(4950, { ...r, conditions: [...r.conditions].reverse() }).final, 5500);
  assert.equal(calculate(5001, r).fixed, 300);
  assert.equal(calculate(6100, r).fixed, 1000);
});
test('collection and price must both match; total sums only matching conditions', () => {
  const collectionId = 'gid://shopify/Collection/1';
  const r = validateRule({ vendor: 'Test', mode: 'margin', targetMargin: '40', vat: '24', addVat: true, conditions: [
    { from: '300', to: '999', amount: '25', collectionId },
    { from: '300', to: '999', amount: '2', collectionId: '' },
  ] });
  const result = calculate(18000, r, true, [collectionId]);
  assert.equal(result.referencePrice, 37200); // €300 × 1.24 → €372
  assert.equal(result.fixed, 2700);
  assert.equal(result.final, 40600); // (€300 + €27) × 1.24 → €406
  assert.equal(calculate(18000, r, true, []).fixed, 200);
  assert.equal(calculate(6000, r, true, [collectionId]).fixed, 0);
  assert.match(calculate(18000, r).error, /συγχρονισμό/);
});
test('condition amounts go before optional VAT and final rounding, including small prices', () => {
  const r = validateRule({ vendor: 'Test', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true, conditions: [{ from: '0', to: '50', amount: '2', collectionId: '' }] });
  assert.equal(calculate(1000, r).referencePrice, 1250);
  assert.equal(calculate(1000, r).final, 1500);
  assert.equal(calculate(1000, { ...r, addVat: false }).final, 1200);
  assert.equal(calculate(1000, r).fixed, 200);
});
test('condition validation rejects malformed ranges, amounts, IDs and oversized lists', () => {
  const input = { vendor: 'Test', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true };
  const good = { from: '0', to: '50', amount: '2', collectionId: '' };
  for (const bad of [{ from: '' }, { to: '' }, { from: '51' }, { amount: '-1' }, { amount: '' }, { collectionId: 'Sleep' }, { collectionId: null }]) assert.throws(() => validateRule({ ...input, conditions: [{ ...good, ...bad }] }));
  assert.throws(() => validateRule({ ...input, conditions: Array(51).fill(good) }));
  assert.throws(() => validateRule({ ...input, conditions: null }));
  assert.equal(validateRule({ ...input, conditions: [{ ...good, from: '50', to: '50' }] }).conditions[0].from, 5000);
});

test('no conditions means no addition, even if a removed legacy field is submitted', () => {
  const r = validateRule({ vendor: 'Test', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true, fixed: '1000', conditions: [] });
  assert.equal(Object.hasOwn(r, 'fixed'), false);
  assert.equal(calculate(6000, r).fixed, 0);
  assert.equal(calculate(6000, r).final, 7500);
});

test('price outside all charge ranges still gets the brand calculation without collections data', () => {
  const input = { vendor: 'Test', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true,
    conditions: [{ from: '300', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/1' }] };
  const r = validateRule(input);
  const outside = calculate(6000, r, true, null);
  assert.equal(outside.final, 10500);
  assert.equal(outside.fixed, 0);
  assert.equal(outside.requiresCollections, false);
  assert.equal(calculate(6000, { ...r, addVat: false }, true, null).final, 8400);
  assert.equal(calculate(6000, { ...r, mode: 'margin', targetMargin: 4000, multiplier: null }, true, null).final, 12400);
  assert.match(calculate(30000, r, true, null).error, /συγχρονισμό/);
  const nonMember = calculate(30000, r, true, []);
  assert.equal(nonMember.final, 52100);
  assert.equal(nonMember.fixed, 0);
});
