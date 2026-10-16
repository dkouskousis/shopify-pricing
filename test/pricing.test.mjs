import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, calculate, validateRule, priceMultiplier } from '../pricing.mjs';
const rule = (addVat = true) => validateRule({ vendor: 'Example', fixed: '0', mode: 'multiplier', multiplier: '1.55', vat: '24', addVat });
test('upward rounding respects half-euro steps, the €20 boundary and exact prices', () => {
  const identity = validateRule({ vendor: 'Test', fixed: '0', mode: 'multiplier', multiplier: '1', vat: '0', addVat: false });
  for (const [cost, final] of [[1, 50], [812, 850], [850, 850], [851, 900], [1950, 1950], [1951, 2000], [1999, 2000], [2000, 2000], [2001, 2100], [2050, 2100], [12435, 12500], [12500, 12500]]) {
    assert.equal(calculate(cost, identity, false).final, final);
  }
  // Less than half a cent above a valid ending still rounds upward.
  assert.equal(calculate(850, { ...identity, multiplier: 10001 }, false).final, 900);
  assert.equal(calculate(2000, { ...identity, multiplier: 10001 }, false).final, 2100);
  // The threshold applies after fixed amount and VAT, not to the purchase cost.
  assert.equal(calculate(1650, { ...identity, addVat: true, vat: 2400 }).final, 2100);
  assert.equal(calculate(1950, { ...identity, fixed: 100 }, false).final, 2100);
});
test('simple formula: purchase cost × entered multiplier × optional VAT', () => {
  assert.equal(calculate(6000, rule()).final, 11600);
  assert.equal(calculate(6000, rule(false)).final, 9300);
  assert.equal(calculate(6000, validateRule({ vendor: 'Example', fixed: '0', mode: 'multiplier', multiplier: '2', vat: '24', addVat: true })).final, 14900);
});
test('disabling VAT addition does not imply tax exemption on sales', () => {
  assert.equal(calculate(6000, rule(false)).net, 7500);
  assert.equal(calculate(6000, rule(false), false).net, 9300);
});
test('upward price rounding preserves exact multiplier conversion', () => {
  assert.equal(calculate(1, validateRule({ vendor: 'Test', fixed: '0', mode: 'multiplier', multiplier: '1.5', vat: '24', addVat: true })).final, 50);
  assert.equal(calculate(6000, validateRule({ vendor: 'Test', fixed: '0', mode: 'multiplier', multiplier: '1.5457', vat: '24', addVat: true })).final, 11600);
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
  const result = calculate(12395, validateRule({ vendor: 'Example', fixed: '0', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(result.final, 21600);
  assert.equal(result.profit, 5024);
  assert.equal(result.margin, 28.84);
});
test('margin mode targets net sales margin instead of purchase markup', () => {
  const rule = validateRule({ vendor: 'Example', fixed: '0', mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
  const result = calculate(6000, rule);
  assert.equal(rule.multiplier, null);
  assert.equal(result.final, 12400);
  assert.equal(result.net, 10000);
  assert.equal(result.profit, 4000);
  assert.equal(result.margin, 40);
  const markedUp = calculate(6000, validateRule({ vendor: 'Example', fixed: '0', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(markedUp.final, 10500);
  assert.equal(markedUp.margin, 29.15);
});
test('margin mode preserves optional VAT behavior and distinguishes taxable sales', () => {
  const rule = validateRule({ vendor: 'Example', fixed: '0', mode: 'margin', targetMargin: '40', vat: '24', addVat: false });
  assert.equal(calculate(6000, rule).final, 10000);
  assert.equal(calculate(6000, rule).margin, 25.6);
  assert.equal(calculate(6000, rule, false).margin, 40);
});
test('margin validation accepts zero and decimals, rejects 100% and malformed inputs', () => {
  const input = { vendor: 'Example', fixed: '0', mode: 'margin', vat: '24', addVat: true };
  assert.equal(calculate(6000, validateRule({ ...input, targetMargin: '0' })).final, 7500);
  assert.equal(validateRule({ ...input, targetMargin: '33,33' }).targetMargin, 3333);
  assert.equal(calculate(1, validateRule({ ...input, targetMargin: '99.99' })).final, 12400);
  for (const targetMargin of ['', '100', '101', '-1', '20.123', 'Infinity']) assert.throws(() => validateRule({ ...input, targetMargin }));
  assert.throws(() => validateRule({ ...input, mode: 'unknown', targetMargin: '40' }));
});
test('fixed addition comes after multiplication and before optional VAT', () => {
  const input = { vendor: 'Example', mode: 'multiplier', multiplier: '1.4', fixed: '10', vat: '24', addVat: true };
  const result = calculate(6000, validateRule(input));
  assert.equal(result.final, 11700);
  assert.equal(result.net, 9435);
  assert.equal(result.profit, 3435);
  assert.equal(calculate(6000, validateRule({ ...input, addVat: false })).final, 9400);
  assert.equal(calculate(6000, validateRule({ ...input, fixed: '' })).final, 10500);
  assert.throws(() => validateRule({ ...input, fixed: '-1' }));
});
test('fixed addition applies after the base margin price and updates actual gross margin', () => {
  const rule = validateRule({ vendor: 'Example', mode: 'margin', targetMargin: '40', fixed: '10', vat: '24', addVat: true });
  const result = calculate(6000, rule);
  assert.equal(result.final, 13700);
  assert.equal(result.profit, 5048);
  assert.equal(result.margin, 45.69);
});
