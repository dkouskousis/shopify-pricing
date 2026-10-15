import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, calculate, validateRule } from '../pricing.mjs';
const rule = (addVat = true) => validateRule({ vendor: 'Example', markup: '55', fixed: '1', vat: '24', addVat });
test('agreed formula: markup, then fixed amount, then optional VAT', () => {
  assert.equal(calculate(6000, rule()).final, 11656);
  assert.equal(calculate(6000, rule(false)).final, 9400);
  assert.equal(calculate(6000, { ...rule(), fixed: 0 }).final, 11532);
});
test('bulky fee is added after markup and treated as a cost', () => {
  const result = calculate(6000, rule(), 2500);
  assert.equal(result.final, 14756);
  assert.equal(result.net, 11900);
  assert.equal(result.profit, 3400);
});
test('disabling VAT addition does not imply tax exemption on sales', () => {
  assert.equal(calculate(6000, rule(false)).net, 7581);
  assert.equal(calculate(6000, rule(false), 0, false).net, 9400);
});
test('money is rounded once, at the end of the calculation', () => {
  assert.equal(calculate(1, validateRule({ vendor: 'Test', markup: '50', fixed: '0', vat: '24', addVat: true })).final, 2);
  assert.equal(decimal('12,50'), 1250);
});
test('missing and invalid input never silently becomes zero', () => {
  assert.match(calculate(null, rule()).error, /Λείπει/);
  assert.match(calculate(6000, null).error, /Λείπει/);
  assert.match(calculate(0, rule()).error, /μηδέν/);
  for (const input of ['', '-1', 'NaN', 'Infinity', '1.234', '1e4']) assert.throws(() => decimal(input));
  assert.throws(() => validateRule({ vendor: 'Test', markup: '', fixed: '0', vat: '24', addVat: true }));
});
