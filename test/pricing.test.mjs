import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, calculate, validateRule, priceMultiplier } from '../pricing.mjs';
const rule = (addVat = true) => validateRule({ vendor: 'Example', mode: 'multiplier', multiplier: '1.55', vat: '24', addVat });
test('simple formula: purchase cost × entered multiplier × optional VAT', () => {
  assert.equal(calculate(6000, rule()).final, 11532);
  assert.equal(calculate(6000, rule(false)).final, 9300);
  assert.equal(calculate(6000, validateRule({ vendor: 'Example', mode: 'multiplier', multiplier: '2', vat: '24', addVat: true })).final, 14880);
});
test('disabling VAT addition does not imply tax exemption on sales', () => {
  assert.equal(calculate(6000, rule(false)).net, 7500);
  assert.equal(calculate(6000, rule(false), false).net, 9300);
});
test('money is rounded once; multiplier supports exact legacy percentage conversion', () => {
  assert.equal(calculate(1, validateRule({ vendor: 'Test', mode: 'multiplier', multiplier: '1.5', vat: '24', addVat: true })).final, 2);
  assert.equal(calculate(6000, validateRule({ vendor: 'Test', mode: 'multiplier', multiplier: '1.5457', vat: '24', addVat: true })).final, 11500);
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
  const result = calculate(12395, validateRule({ vendor: 'Example', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(result.final, 21518);
  assert.equal(result.profit, 4958);
  assert.equal(result.margin, 28.57);
});
test('margin mode targets net sales margin instead of purchase markup', () => {
  const rule = validateRule({ vendor: 'Example', mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
  const result = calculate(6000, rule);
  assert.equal(rule.multiplier, null);
  assert.equal(result.final, 12400);
  assert.equal(result.net, 10000);
  assert.equal(result.profit, 4000);
  assert.equal(result.margin, 40);
  const markedUp = calculate(6000, validateRule({ vendor: 'Example', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true }));
  assert.equal(markedUp.final, 10416);
  assert.equal(markedUp.margin, 28.57);
});
test('margin mode preserves optional VAT behavior and distinguishes taxable sales', () => {
  const rule = validateRule({ vendor: 'Example', mode: 'margin', targetMargin: '40', vat: '24', addVat: false });
  assert.equal(calculate(6000, rule).final, 10000);
  assert.equal(calculate(6000, rule).margin, 25.6);
  assert.equal(calculate(6000, rule, false).margin, 40);
});
test('margin validation accepts zero and decimals, rejects 100% and malformed inputs', () => {
  const input = { vendor: 'Example', mode: 'margin', vat: '24', addVat: true };
  assert.equal(calculate(6000, validateRule({ ...input, targetMargin: '0' })).final, 7440);
  assert.equal(validateRule({ ...input, targetMargin: '33,33' }).targetMargin, 3333);
  assert.equal(calculate(1, validateRule({ ...input, targetMargin: '99.99' })).final, 12400);
  for (const targetMargin of ['', '100', '101', '-1', '20.123', 'Infinity']) assert.throws(() => validateRule({ ...input, targetMargin }));
  assert.throws(() => validateRule({ ...input, mode: 'unknown', targetMargin: '40' }));
});
