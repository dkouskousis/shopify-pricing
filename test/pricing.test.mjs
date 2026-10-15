import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, calculate, validateRule, priceMultiplier } from '../pricing.mjs';
const rule = (addVat = true) => validateRule({ vendor: 'Example', multiplier: '1.55', vat: '24', addVat });
test('simple formula: purchase cost × entered multiplier × optional VAT', () => {
  assert.equal(calculate(6000, rule()).final, 11532);
  assert.equal(calculate(6000, rule(false)).final, 9300);
  assert.equal(calculate(6000, validateRule({ vendor: 'Example', multiplier: '2', vat: '24', addVat: true })).final, 14880);
});
test('disabling VAT addition does not imply tax exemption on sales', () => {
  assert.equal(calculate(6000, rule(false)).net, 7500);
  assert.equal(calculate(6000, rule(false), false).net, 9300);
});
test('money is rounded once; multiplier supports exact legacy percentage conversion', () => {
  assert.equal(calculate(1, validateRule({ vendor: 'Test', multiplier: '1.5', vat: '24', addVat: true })).final, 2);
  assert.equal(calculate(6000, validateRule({ vendor: 'Test', multiplier: '1.5457', vat: '24', addVat: true })).final, 11500);
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
