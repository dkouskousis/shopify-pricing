import test from 'node:test';
import assert from 'node:assert/strict';
import { filterProducts } from '../public/product-filters.mjs';
const items = [
  { id: 1, status: 'ACTIVE', price: 10000, vendor: 'A', title: 'Bed', variant: 'Small', sku: 'A1', result: { final: 11532 } },
  { id: 2, status: 'ACTIVE', price: 0, vendor: 'A', title: 'Bed', variant: 'Large', sku: 'A2', result: { error: 'Missing cost' } },
  { id: 3, status: 'DRAFT', price: 10000, vendor: 'B', title: 'Bowl', variant: 'Small', sku: 'B1', result: { final: 10000 } },
  { id: 4, status: 'ARCHIVED', price: 0, vendor: 'B', title: 'Bed', variant: 'Large', sku: 'B2', result: { error: 'Archived' } },
];
const filters = { search: '', vendor: '', change: 'all', status: 'all', price: 'all' };
const ids = input => filterProducts(items, { ...filters, ...input }).map(p => p.id);
test('active and inactive status filters include all non-active states', () => {
  assert.deepEqual(ids({ status: 'active' }), [1, 2]);
  assert.deepEqual(ids({ status: 'inactive' }), [3, 4]);
  assert.deepEqual(ids({}), [1, 2, 3, 4]);
});
test('Product Price means selling price, independently of cost or calculation status', () => {
  assert.deepEqual(ids({ price: 'filled' }), [1, 3]);
  assert.deepEqual(ids({ price: 'empty' }), [2, 4]);
  assert.deepEqual(filterProducts([{ ...items[0], price: null }], { ...filters, price: 'empty' }).map(p => p.id), [1]);
});
test('all filters combine and bulk-selection source receives only matching products', () => {
  assert.deepEqual(ids({ status: 'active', price: 'filled', vendor: 'A', search: 'a1', change: 'changed' }), [1]);
  assert.deepEqual(ids({ status: 'inactive', price: 'empty', change: 'missing' }), [4]);
  assert.deepEqual(ids({ status: 'active', price: 'filled', vendor: 'B' }), []);
});
