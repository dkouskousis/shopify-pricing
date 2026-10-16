import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionPages, productCollectionIds } from '../shopify.mjs';
const page = (ids, next = null) => ({ nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage: next !== null, endCursor: next } });
test('collection membership follows every page and normalizes ordering and duplicates', async () => {
  const calls = [];
  const ids = await productCollectionIds(async (query, variables) => {
    calls.push(variables);
    return { product: { collections: page(['1', '2']) } };
  }, 'product', page(['3', '1'], 'next'));
  assert.deepEqual(ids, ['1', '2', '3']);
  assert.deepEqual(calls, [{ id: 'product', after: 'next' }]);
});
test('catalog pages include collections from later pages and reject broken cursors', async () => {
  const calls = [];
  const nodes = await collectionPages(async after => { calls.push(after); return after === null ? page(['1'], 'next') : page(['2']); });
  assert.deepEqual(nodes.map(n => n.id), ['1', '2']);
  assert.deepEqual(calls, [null, 'next']);
  await assert.rejects(collectionPages(async () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } })), /cursor/);
  await assert.rejects(collectionPages(async () => page(['1'], 'repeat')), /cursor/);
  await assert.rejects(productCollectionIds(async () => ({ product: null }), 'missing'), /δεν υπάρχει/);
});
