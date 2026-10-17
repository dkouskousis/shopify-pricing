import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createApplication } from '../server.mjs';
import { createShopify, validateSettings } from '../shopify.mjs';
import { openStore } from '../store.mjs';

const config = { appUrl: 'http://localhost', password: 'a-long-test-password-2026', encryptionKey: 'ab'.repeat(32), dbPath: ':memory:' };
const id = n => `gid://shopify/ProductVariant/${n}`;
function variant(n, price = '100.00', cost = '60.00') {
  return { id: id(n), title: 'Medium', price, compareAtPrice: null, taxable: true,
    inventoryItem: { id: 'gid://shopify/InventoryItem/' + n, sku: 'TEST-' + n, unitCost: cost === null ? null : { amount: cost, currencyCode: 'EUR' } },
    product: { id: 'gid://shopify/Product/9', title: 'Test product ' + n, vendor: 'Example', conditions: [], status: 'ACTIVE' } };
}
async function harness(t, variants = [variant(1)]) {
  let collectionIds = ['gid://shopify/Collection/1'];
  let mutations = [], costMutations = [], pages = 0, pageError = false, mutationError = false, costFailure = null, collectionsError = false;
  const api = async (query, variables) => {
    if (query.includes('ShopInfo')) return { shop: { name: 'Test shop', myshopifyDomain: 'example.myshopify.com', currencyCode: 'EUR' } };
    if (query.includes('PricingCollections') && collectionsError) throw new Error('Collections sync failed');
    if (query.includes('PricingCollections')) return { collections: { nodes: [{ id: 'gid://shopify/Collection/1', title: 'Sleep' }], pageInfo: { hasNextPage: false, endCursor: null } } };
    if (query.includes('PricingMemberships')) return { nodes: variables.ids.map(id => ({ id, collections: { nodes: [{ id: 'gid://shopify/Collection/1' }], pageInfo: { hasNextPage: false, endCursor: null } } })) };
    if (query.includes('PricingProductCollections')) return { product: { collections: { nodes: collectionIds.map(id => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } } } };
    if (query.includes('PricingVariants')) {
      pages++;
      if (pageError) throw new Error('Sync failed');
      const index = variables.after ? Number(variables.after) : 0;
      return { productVariants: { nodes: variants.slice(index, index + 1), pageInfo: { hasNextPage: index + 1 < variants.length, endCursor: String(index + 1) } } };
    }
    if (query.includes('CurrentPricingVariant')) return { productVariant: variants.find(v => v.id === variables.id) ?? null };
    if (query.includes('UpdatePricingVariant')) {
      mutations.push(variables);
      if (mutationError) throw new Error('Network timeout during write');
      const update = variables.variants[0], v = variants.find(v => v.id === update.id); v.price = update.price;
      return { productVariantsBulkUpdate: { productVariants: [{ id: v.id, price: v.price }], userErrors: [] } };
    }
    if (query.includes('UpdatePricingCost')) {
      costMutations.push(variables);
      if (costFailure === 'network') throw new Error('Network timeout during cost write');
      if (costFailure === 'denied') return { inventoryItemUpdate: { inventoryItem: null, userErrors: [{ message: 'Missing write_inventory permission' }] } };
      const v = variants.find(v => v.inventoryItem.id === variables.id);
      v.inventoryItem.unitCost = { amount: variables.input.cost, currencyCode: 'EUR' };
      return { inventoryItemUpdate: { inventoryItem: v.inventoryItem, userErrors: [] } };
    }
    throw new Error('Unexpected operation');
  };
  const app = createApplication(config, { makeShopify: () => api });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '', csrf = '';
  async function request(path, input, extra = {}) {
    const response = await fetch(base + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: {
      Origin: config.appUrl, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extra },
      body: input === undefined ? undefined : JSON.stringify(input) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  async function login() {
    assert.equal((await request('login', { password: config.password })).status, 200);
    const s = await request('state'); csrf = s.data.csrf;
  }
  async function idle() {
    for (let i = 0; i < 100; i++) { const s = await request('state'); if (!s.data.job.running) return s.data; await setTimeout(5); }
    throw new Error('Job timed out');
  }
  async function setup() {
    await login();
    assert.equal((await request('settings', { shop: 'example.myshopify.com', mode: 'access_token', clientId: '', clientSecret: '', accessToken: 'private-token' })).status, 200);
    assert.equal((await request('rules', { vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.55', vat: '24', addVat: true })).status, 200);
    assert.equal((await request('sync', {})).status, 202); await idle();
  }
  return { app, request, setup, login, idle, setCollections: ids => { collectionIds = ids; }, setCollectionsError: () => { collectionsError = true; }, mutations, costMutations, setCostFailure: value => { costFailure = value; }, setPageError: () => { pageError = true; }, setMutationError: () => { mutationError = true; }, pages: () => pages };
}
test('authentication, origin and CSRF guard every write; secrets are masked', async t => {
  const h = await harness(t);
  assert.equal((await h.request('state')).status, 401);
  assert.equal((await h.request('login', { password: config.password }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request('login', { password: 'wrong' })).status, 401);
  await h.setup();
  assert.equal((await h.request('rules', {}, { 'X-CSRF-Token': '' })).status, 403);
  const state = (await h.request('state')).data;
  assert.equal(state.settings.hasAccessToken, true);
  assert.ok(!JSON.stringify(state).includes('private-token'));
  assert.equal((await h.request('settings', { ...state.settings, shop: 'other.myshopify.com', clientSecret: '', accessToken: '' })).status, 400);
  assert.equal((await h.request('logout', {})).status, 200);
  assert.equal((await h.request('state')).status, 401);
});
test('sync paginates all variants and failed sync preserves previous cache', async t => {
  const h = await harness(t, [variant(1), variant(2), variant(3, '20', null)]); await h.setup();
  assert.equal(h.pages(), 3);
  const state = (await h.request('state')).data;
  assert.equal(state.products.length, 3);
  assert.match(state.products[2].result.error, /κόστος/);
  h.setPageError(); await h.request('sync', {});
  const after = await h.idle();
  assert.equal(after.products.length, 3); assert.match(after.job.error, /Sync failed/);
});
test('preview is immutable, one-use, and only selected prices are written', async t => {
  const h = await harness(t, [variant(1), variant(2)]); await h.setup();
  const preview = await h.request('preview', { ids: [id(1)] });
  assert.equal(preview.data.items[0].newPrice, 11600);
  assert.equal(h.mutations.length, 0);
  assert.equal((await h.request('apply', { id: preview.data.id, price: 1 })).status, 202);
  const state = await h.idle();
  assert.equal(h.mutations.length, 1);
  assert.deepEqual(h.mutations[0].variants, [{ id: id(1), price: '116.00' }]);
  assert.equal(state.products.find(v => v.id === id(2)).price, 10000);
  assert.equal(state.audit[0].status, 'success');
  assert.equal((await h.request('apply', { id: preview.data.id })).status, 409);
});
test('changed Shopify cost/price rejects a stale update and logs failure', async t => {
  const variants = [variant(1)], h = await harness(t, variants); await h.setup();
  const p = (await h.request('preview', { ids: [id(1)] })).data;
  variants[0].inventoryItem.unitCost.amount = '65.00';
  await h.request('apply', { id: p.id }); const state = await h.idle();
  assert.equal(h.mutations.length, 0); assert.equal(state.audit[0].status, 'failed');
});
test('rule edits invalidate saved previews', async t => {
  const h = await harness(t); await h.setup();
  const p = (await h.request('preview', { ids: [id(1)] })).data;
  await h.request('rules', { vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.60', vat: '24', addVat: true });
  assert.equal((await h.request('apply', { id: p.id })).status, 409);
  assert.equal((await h.request('state')).data.products[0].result.final, 11995);
});
test('compare-at price conflicts block changes without touching the sale setup', async t => {
  const v = variant(1); v.compareAtPrice = '110';
  const h = await harness(t, [v]); await h.setup();
  assert.equal((await h.request('preview', { ids: [id(1)] })).status, 400);
  assert.equal(h.mutations.length, 0);
});
test('uncertain writes are recorded and cannot be automatically replayed', async t => {
  const h = await harness(t); await h.setup(); h.setMutationError();
  const preview = (await h.request('preview', { ids: [id(1)] })).data;
  await h.request('apply', { id: preview.id });
  const state = await h.idle();
  assert.equal(state.audit[0].status, 'uncertain');
  assert.equal(h.mutations.length, 1);
  assert.equal((await h.request('apply', { id: preview.id })).status, 409);
});
test('expired previews are rejected and rule edits invalidate fresh previews', async t => {
  const h = await harness(t); await h.setup();
  const p = (await h.request('preview', { ids: [id(1)] })).data;
  h.app.store.db.prepare('UPDATE previews SET expires=0 WHERE id=?').run(p.id);
  assert.equal((await h.request('apply', { id: p.id })).status, 409);
  const p2 = (await h.request('preview', { ids: [id(1)] })).data;
  await h.request('rules', { vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1.60', vat: '24', addVat: true });
  assert.equal((await h.request('apply', { id: p2.id })).status, 409);
});
test('credential encryption round-trips and does not expose the plaintext', () => {
  const s = openStore(':memory:', config.encryptionKey);
  s.saveSettings({ accessToken: 'secret-value' });
  assert.equal(s.settings().accessToken, 'secret-value');
  assert.ok(!JSON.stringify(s.get('settings')).includes('secret-value'));
  s.db.close();
});
test('client credentials exchange is cached, GraphQL auth header is server-only', async () => {
  let authCalls = 0;
  const api = createShopify({ shop: 'example.myshopify.com', mode: 'client_credentials', clientId: 'id', clientSecret: 'secret' }, async (url, options) => {
    if (url.endsWith('/access_token')) { authCalls++; return { ok: true, json: async () => ({ access_token: 'token', expires_in: 86399 }) }; }
    assert.equal(options.headers['X-Shopify-Access-Token'], 'token');
    return { ok: true, json: async () => ({ data: { shop: { name: 'Shop' } } }) };
  });
  await api('query {}'); await api('query {}'); assert.equal(authCalls, 1);
});
test('invalid settings cannot send credentials to arbitrary hosts', () => {
  const data = { mode: 'access_token', clientId: '', clientSecret: '', accessToken: 'token' };
  for (const shop of ['localhost', 'example.com', 'x.myshopify.com.evil.com', 'https://example.myshopify.com', 'example.myshopify.com/path']) assert.throws(() => validateSettings({ ...data, shop }));
  assert.equal(validateSettings({ ...data, shop: 'example.myshopify.com' }).shop, 'example.myshopify.com');
});

test('editing cost saves only the selected inventory item, verifies readback and recalculates', async t => {
  const variants = [variant(1), variant(2)];
  const h = await harness(t, variants); await h.setup();
  const preview = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal((await h.request('cost', { id: id(1), cost: '65,00', expectedCost: 6000 })).status, 200);
  assert.deepEqual(h.costMutations, [{ id: 'gid://shopify/InventoryItem/1', input: { cost: '65.00' } }]);
  assert.equal(h.mutations.length, 0);
  assert.equal(variants[0].price, '100.00');
  assert.equal(variants[1].inventoryItem.unitCost.amount, '60.00');
  const state = (await h.request('state')).data;
  assert.equal(state.products.find(v => v.id === id(1)).cost, 6500);
  assert.equal(state.products.find(v => v.id === id(1)).result.final, 12495);
  assert.equal(state.audit[0].kind, 'cost');
  assert.equal(state.audit[0].status, 'success');
  assert.equal((await h.request('apply', { id: preview.id })).status, 409);
});
test('missing purchase cost can be filled from the product list', async t => {
  const h = await harness(t, [variant(1, '100', null)]); await h.setup();
  assert.equal((await h.request('cost', { id: id(1), cost: '60', expectedCost: null })).status, 200);
  const s = (await h.request('state')).data;
  assert.equal(s.products[0].result.final, 11600);
  assert.equal(s.audit[0].old_missing, 1);
});
test('cost writes reject stale costs, bad input and absent CSRF', async t => {
  const variants = [variant(1)], h = await harness(t, variants); await h.setup();
  assert.equal((await h.request('cost', { id: id(1), cost: '65', expectedCost: 6000 }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await h.request('cost', { id: id(1), cost: '-1', expectedCost: 6000 })).status, 400);
  assert.equal((await h.request('cost', { id: id(1), cost: '65', expectedCost: 5000 })).status, 409);
  variants[0].inventoryItem.unitCost.amount = '62';
  assert.equal((await h.request('cost', { id: id(1), cost: '65', expectedCost: 6000 })).status, 409);
  assert.equal(h.costMutations.length, 0);
  assert.equal((await h.request('state')).data.products[0].cost, 6000);
});
test('failed or uncertain cost writes do not become successful local costs', async t => {
  const h = await harness(t); await h.setup(); h.setCostFailure('denied');
  assert.equal((await h.request('cost', { id: id(1), cost: '65', expectedCost: 6000 })).status, 400);
  let s = (await h.request('state')).data;
  assert.equal(s.products[0].cost, 6000); assert.equal(s.audit[0].status, 'failed');
  h.setCostFailure('network');
  const response = await h.request('cost', { id: id(1), cost: '65', expectedCost: 6000 });
  assert.equal(response.status, 400); assert.match(response.data.error, /αβέβαιο/);
  s = (await h.request('state')).data;
  assert.equal(s.products[0].cost, 6000); assert.equal(s.audit[0].status, 'uncertain');
});
test('margin rules persist, preview and apply the intended price, then recalculate after cost edits', async t => {
  const h = await harness(t); await h.setup();
  const result = await h.request('rules', { vendor: 'Example', conditions: [], mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
  assert.equal(result.status, 200);
  const state = (await h.request('state')).data;
  assert.equal(state.rules[0].mode, 'margin');
  assert.equal(state.products[0].result.margin, 40);
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 12400);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '124.00');
  await h.request('cost', { id: id(1), cost: '65', expectedCost: 6000 });
  const after = (await h.request('state')).data;
  assert.equal(after.products[0].result.final, 13495);
  assert.equal(after.products[0].result.margin, 40.27);
});
test('fixed rule amount persists and flows through preview and Shopify price apply', async t => {
  const h = await harness(t); await h.setup();
  const response = await h.request('rules', { vendor: 'Example', conditions: [{ from: '0', to: '1000', amount: '10', collectionId: '' }], mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true });
  assert.equal(response.status, 200);
  assert.equal((await h.request('state')).data.rules[0].conditions[0].amount, 1000);
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 11700);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '117.00');
});
test('small product price uses half-euro rounding consistently through Shopify apply', async t => {
  const h = await harness(t, [variant(1, '8.00', '8.12')]); await h.setup();
  await h.request('rules', { vendor: 'Example', conditions: [], mode: 'multiplier', multiplier: '1', vat: '0', addVat: false });
  const state = (await h.request('state')).data;
  assert.deepEqual(state.products[0].result, { final: 850, net: 850, profit: 38, margin: 4.47, fixed: 0, referencePrice: 850, requiresCollections: false });
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 850);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '8.50');
});

test('conditional totals persist and match state, preview and Shopify writes', async t => {
  const h = await harness(t, [variant(1, '300.00', '300.00')]); await h.setup();
  const conditions = [
    { from: '300', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/1' },
    { from: '300', to: '999', amount: '2', collectionId: '' },
  ];
  assert.equal((await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true, conditions })).status, 200);
  const state = (await h.request('state')).data;
  assert.equal(state.collections[0].title, 'Sleep');
  assert.deepEqual(state.products[0].collectionIds, ['gid://shopify/Collection/1']);
  assert.equal(state.rules[0].conditions.length, 2);
  assert.equal(state.products[0].result.fixed, 2700);
  assert.equal(state.products[0].result.final, 40600);
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 40600);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '406.00');
});
test('collection membership changes reject a stale price update before writing', async t => {
  const h = await harness(t); await h.setup();
  await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true,
    conditions: [{ from: '0', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/1' }] });
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  h.setCollections([]);
  await h.request('apply', { id: plan.id }); const state = await h.idle();
  assert.equal(h.mutations.length, 0);
  assert.equal(state.audit[0].status, 'failed');
  assert.match(state.audit[0].detail, /collections/);
});
test('unknown collection IDs cannot be silently saved', async t => {
  const h = await harness(t); await h.setup();
  const result = await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1', vat: '24', addVat: true,
    conditions: [{ from: '0', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/999' }] });
  assert.equal(result.status, 400);
  assert.equal((await h.request('state')).data.rules[0].conditions.length, 0);
});

test('failed collections sync keeps previous variants, collections and timestamp together', async t => {
  const variants = [variant(1)], h = await harness(t, variants); await h.setup();
  const before = (await h.request('state')).data;
  variants[0].inventoryItem.unitCost.amount = '999.00';
  h.setCollectionsError();
  await h.request('sync', {}); const after = await h.idle();
  assert.match(after.job.error, /Collections sync failed/);
  assert.equal(after.products[0].cost, 6000);
  assert.deepEqual(after.collections, before.collections);
  assert.equal(after.lastSync, before.lastSync);
});

test('one preview applies both products inside and outside additional charge ranges', async t => {
  for (const settings of [
    { mode: 'multiplier', multiplier: '1.55', addVat: true, prices: ['116.00', '608.00'] },
    { mode: 'multiplier', multiplier: '1.55', addVat: false, prices: ['93.00', '489.95'] },
    { mode: 'margin', targetMargin: '40', addVat: true, prices: ['124.00', '651.00'] },
  ]) await t.test(`${settings.mode}, addVat=${settings.addVat}`, async t => {
    const h = await harness(t, [variant(1, '100', '60'), variant(2, '100', '300')]); await h.setup();
    await h.request('rules', { vendor: 'Example', ...settings, vat: '24',
      conditions: [{ from: '300', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/1' }] });
    // A price outside the charge band does not depend on any collection data.
    const uncharged = h.app.store.variant(id(1));
    h.app.store.db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({ ...uncharged, collectionIds: null }), id(1));
    const state = (await h.request('state')).data;
    assert.equal(state.products[0].result.fixed, 0);
    assert.equal(state.products[1].result.fixed, 2500);
    const plan = (await h.request('preview', { ids: [id(1), id(2)] })).data;
    assert.equal(plan.items.length, 2);
    assert.equal(plan.items[0].checkCollections, false);
    assert.equal(plan.items[1].checkCollections, true);
    await h.request('apply', { id: plan.id }); const after = await h.idle();
    assert.deepEqual(h.mutations.map(m => m.variants[0].price), settings.prices);
    assert.ok(after.audit.every(a => a.status === 'success'));
  });
});
test('a known non-member product within a charge range still receives the base price', async t => {
  const h = await harness(t, [variant(1, '100', '300')]); await h.setup();
  h.setCollections([]);
  const v = h.app.store.variant(id(1));
  h.app.store.db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({ ...v, collectionIds: [] }), id(1));
  await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1.4', vat: '24', addVat: true,
    conditions: [{ from: '300', to: '999', amount: '25', collectionId: 'gid://shopify/Collection/1' }] });
  assert.equal((await h.request('state')).data.products[0].result.fixed, 0);
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 52100);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '521.00');
});

test('sync caches thumbnail and large image metadata; missing images stay absent', async t => {
  const variants = [variant(1), variant(2)];
  const image = { thumbnail: 'https://cdn.shopify.com/test-80.jpg', url: 'https://cdn.shopify.com/test-1600.jpg', altText: 'Dog cushion' };
  variants[0].product.featuredMedia = { preview: { image } };
  variants[1].product.featuredMedia = null;
  const h = await harness(t, variants); await h.setup();
  const state = (await h.request('state')).data;
  assert.deepEqual(state.products[0].image, image);
  assert.equal(state.products[1].image, null);
  const response = await fetch('http://127.0.0.1:' + h.app.server.address().port);
  assert.match(response.headers.get('content-security-policy'), /img-src 'self' https:\/\/cdn.shopify.com;/);
});

test('manual selling price saves exact cents for one variant and invalidates old previews', async t => {
  const variants = [variant(1), variant(2)]; variants[0].compareAtPrice = '150.00';
  const h = await harness(t, variants); await h.setup();
  const oldPlan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal((await h.request('price', { id: id(1), price: '110,45', expectedPrice: 10000 })).status, 200);
  assert.deepEqual(h.mutations, [{ productId: 'gid://shopify/Product/9', variants: [{ id: id(1), price: '110.45' }] }]);
  assert.equal(h.costMutations.length, 0);
  assert.equal(variants[0].compareAtPrice, '150.00');
  assert.equal(variants[0].inventoryItem.unitCost.amount, '60.00');
  assert.equal(variants[1].price, '100.00');
  const state = (await h.request('state')).data;
  assert.equal(state.products[0].price, 11045);
  assert.equal(state.products[0].result.final, 11600);
  assert.equal(state.audit[0].kind, 'price');
  assert.equal(state.audit[0].status, 'success');
  assert.match(state.audit[0].detail, /Χειροκίνητη/);
  assert.equal((await h.request('apply', { id: oldPlan.id })).status, 409);
});
test('manual price rejects stale prices, invalid amounts, compare-at conflicts and missing CSRF', async t => {
  const variants = [variant(1)], h = await harness(t, variants); await h.setup();
  for (const price of ['0', '-1', '1.234', '']) assert.equal((await h.request('price', { id: id(1), price, expectedPrice: 10000 })).status, 400);
  assert.equal((await h.request('price', { id: id(1), price: '90', expectedPrice: 10000 }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await h.request('price', { id: id(1), price: '90', expectedPrice: 9000 })).status, 409);
  variants[0].compareAtPrice = '110';
  assert.equal((await h.request('price', { id: id(1), price: '110', expectedPrice: 10000 })).status, 400);
  variants[0].price = '95';
  assert.equal((await h.request('price', { id: id(1), price: '90', expectedPrice: 10000 })).status, 409);
  assert.equal(h.mutations.length, 0);
});
test('manual price remains usable without a purchase cost and unchanged prices do not write', async t => {
  const h = await harness(t, [variant(1, '100.00', null)]); await h.setup();
  const same = await h.request('price', { id: id(1), price: '100', expectedPrice: 10000 });
  assert.equal(same.data.unchanged, true); assert.equal(h.mutations.length, 0);
  assert.equal((await h.request('price', { id: id(1), price: '89.40', expectedPrice: 10000 })).status, 200);
  assert.equal((await h.request('state')).data.products[0].price, 8940);
});
test('uncertain manual price writes preserve cached price and log uncertainty', async t => {
  const h = await harness(t); await h.setup(); h.setMutationError();
  const response = await h.request('price', { id: id(1), price: '90', expectedPrice: 10000 });
  assert.equal(response.status, 400); assert.match(response.data.error, /αβέβαιο/);
  const state = (await h.request('state')).data;
  assert.equal(state.products[0].price, 10000);
  assert.equal(state.audit[0].status, 'uncertain');
  assert.equal(state.job.priceSaving, false);
});

test('five-cent endings are identical in state, preview and automatic Shopify writes; manual prices remain exact', async t => {
  const h = await harness(t, [variant(1, '30.00', '20.00')]); await h.setup();
  await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1', vat: '0', addVat: false, conditions: [] });
  const state = (await h.request('state')).data;
  assert.equal(state.products[0].result.final, 1995);
  const plan = (await h.request('preview', { ids: [id(1)] })).data;
  assert.equal(plan.items[0].newPrice, 1995);
  await h.request('apply', { id: plan.id }); await h.idle();
  assert.equal(h.mutations[0].variants[0].price, '19.95');
  await h.request('price', { id: id(1), price: '20.00', expectedPrice: 1995 });
  assert.equal(h.mutations[1].variants[0].price, '20.00');
});

test('2000 selected variants apply successfully as individual Shopify writes; selection is capped at 2000', async t => {
  const variants = Array.from({ length: 2001 }, (_, i) => variant(i + 1));
  const h = await harness(t, variants); await h.setup();
  const ids = variants.slice(0, 2000).map(v => v.id);
  const plan = await h.request('preview', { ids });
  assert.equal(plan.status, 200); assert.equal(plan.data.items.length, 2000);
  assert.equal((await h.request('preview', { ids: variants.slice(0, 2000).map(v => v.id) })).status, 200);
  assert.equal((await h.request('preview', { ids: Array.from({ length: 2001 }, (_, i) => id(i + 1)) })).status, 400);
  assert.equal((await h.request('preview', { ids: [id(2), id(2)] })).status, 400);
  assert.equal((await h.request('apply', { id: plan.data.id })).status, 202);
  const state = await h.idle();
  assert.equal(state.job.total, 2000); assert.equal(state.job.completed, 2000);
  assert.equal(h.app.store.db.prepare("SELECT count(*) AS n FROM audit WHERE status='success'").get().n, 2000);
  assert.equal(h.mutations.length, 2000);
  assert.ok(h.mutations.every(m => m.variants.length === 1));
  assert.ok(variants.slice(0, 2000).every(v => v.price === '116.00'));
  assert.ok(variants.slice(2000).every(v => v.price === '100.00'));
});
test('manual bulk costs fill missing costs without supplier rules, update only selected costs and keep selling prices', async t => {
  const variants = [variant(1), variant(2,'200',null), variant(3)], h = await harness(t, variants); await h.setup();
  h.app.store.db.exec('DELETE FROM rules');
  const p = await h.request('manual/preview',{ ids:[id(1),id(2)], field:'cost',mode:'set',value:'12,34' });
  assert.equal(p.status,200);assert.deepEqual(p.data.items.map(i=>i.oldValue),[6000,null]);assert.equal(p.data.items[0].sku,'TEST-1');assert.equal(h.costMutations.length,0);
  assert.equal((await h.request('apply',{id:p.data.id})).status,409);
  assert.equal((await h.request('manual/apply',{id:p.data.id,value:'1'})).status,202);const s=await h.idle();
  assert.equal(h.costMutations.length,2);assert.equal(h.mutations.length,0);assert.equal(variants[0].price,'100.00');assert.equal(variants[1].price,'200');assert.equal(variants[2].inventoryItem.unitCost.amount,'60.00');
  assert.deepEqual(s.products.slice(0,2).map(v=>v.cost),[1234,1234]);assert.equal(s.audit[0].kind,'cost');assert.equal(s.audit[0].old_missing,1);assert.equal(s.audit[0].sku,'TEST-2');assert.equal(s.audit[0].status,'success');
  assert.equal((await h.request('manual/apply',{id:p.data.id})).status,409);
});
test('manual bulk selling price changes use existing selling price, preserve exact cents and never change costs or supplier rules', async t => {
  const variants = [variant(1,'100'), variant(2,'200')], h=await harness(t,variants);await h.setup();
  const rules=h.app.store.rules();const p=await h.request('manual/preview',{ids:[id(1),id(2)],field:'price',mode:'percent',value:'-10'});
  assert.equal(p.status,200);assert.deepEqual(p.data.items.map(i=>i.newValue),[9000,18000]);await h.request('manual/apply',{id:p.data.id});const s=await h.idle();
  assert.deepEqual(s.products.map(v=>v.price),[9000,18000]);assert.equal(h.costMutations.length,0);assert.deepEqual(h.app.store.rules(),rules);assert.equal(s.audit[0].kind,'price');assert.equal(s.audit[0].sku,'TEST-2');
  const exact=(await h.request('manual/preview',{ids:[id(1)],field:'price',mode:'set',value:'20'})).data;
  await h.request('manual/apply',{id:exact.id});await h.idle();assert.equal(variants[0].price,'20.00');
});
test('manual bulk preview validates modes, currencies, missing cost, size, CSRF and preview kinds', async t => {
  const h=await harness(t,[variant(1),variant(2,'100',null)]);await h.setup();const input={ids:[id(1)],field:'cost',mode:'fixed',value:'2'};
  assert.equal((await h.request('manual/preview',input,{'X-CSRF-Token':''})).status,403);
  for(const change of [{field:'other'},{mode:'other'},{value:'abc'},{value:'-1000'},{ids:[]},{ids:[id(1),id(1)]},{ids:Array.from({length:2001},(_,i)=>id(i+1))},{ids:[id(2)]}])assert.equal((await h.request('manual/preview',{...input,...change})).status,400);
  assert.equal((await h.request('manual/preview',{...input,field:'price',mode:'set',value:'0'})).status,400);
  const normal=(await h.request('preview',{ids:[id(1)]})).data;assert.equal((await h.request('manual/apply',{id:normal.id})).status,409);
  const v=h.app.store.variant(id(1));h.app.store.db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({...v,currency:'USD'}),v.id);
  assert.equal((await h.request('manual/preview',input)).status,400);
});
test('manual bulk costs reject stale live costs per variant and continue the other selected writes', async t=>{
  const variants=[variant(1),variant(2)],h=await harness(t,variants);await h.setup();
  const p=(await h.request('manual/preview',{ids:[id(1),id(2)],field:'cost',mode:'fixed',value:'2'})).data;
  variants[0].inventoryItem.unitCost.amount='65';await h.request('manual/apply',{id:p.id});const s=await h.idle();
  assert.equal(h.costMutations.length,1);assert.equal(variants[0].inventoryItem.unitCost.amount,'65');assert.equal(variants[1].inventoryItem.unitCost.amount,'62.00');
  assert.equal(s.audit.find(a=>a.variant_id===id(1)).status,'failed');assert.equal(s.audit.find(a=>a.variant_id===id(2)).status,'success');assert.equal(s.job.completed,2);
});
test('manual bulk selling prices protect fresh compare-at conflicts and uncertain results are never replayed', async t=>{
  const variants=[variant(1),variant(2)],h=await harness(t,variants);await h.setup();
  const p=(await h.request('manual/preview',{ids:[id(1),id(2)],field:'price',mode:'fixed',value:'2'})).data;
  variants[0].compareAtPrice='101';h.setMutationError();await h.request('manual/apply',{id:p.id});const s=await h.idle();
  assert.equal(h.mutations.length,1);assert.equal(s.audit.find(a=>a.variant_id===id(1)).status,'failed');assert.equal(s.audit.find(a=>a.variant_id===id(2)).status,'uncertain');assert.equal(s.products[1].price,10000);
  assert.equal((await h.request('manual/apply',{id:p.id})).status,409);
});
test('expired manual bulk previews are rejected',async t=>{
  const h=await harness(t);await h.setup();const p=(await h.request('manual/preview',{ids:[id(1)],field:'cost',mode:'set',value:'50'})).data;
  h.app.store.db.prepare('UPDATE previews SET expires=0 WHERE id=?').run(p.id);assert.equal((await h.request('manual/apply',{id:p.id})).status,409);assert.equal(h.costMutations.length,0);
});
test('manual bulk costs apply 2000 selected variants as individually verified writes',async t=>{
  const variants=Array.from({length:2000},(_,i)=>variant(i+1)),h=await harness(t,variants);
  await h.login();h.app.store.saveSettings({shop:'example.myshopify.com',mode:'access_token',accessToken:'mock'});
  const insert=h.app.store.db.prepare('INSERT INTO variants VALUES (?,?)');
  for(const v of variants)insert.run(v.id,JSON.stringify({id:v.id,productId:v.product.id,title:v.product.title,variant:v.title,sku:v.inventoryItem.sku,vendor:v.product.vendor,status:'ACTIVE',price:10000,cost:6000,currency:'EUR',taxable:true,compareAt:null,collectionIds:[]}));
  const p=await h.request('manual/preview',{ids:variants.map(v=>v.id),field:'cost',mode:'percent',value:'-10'});assert.equal(p.status,200);assert.equal(p.data.items.length,2000);
  assert.equal((await h.request('manual/apply',{id:p.data.id})).status,202);const s=await h.idle();assert.equal(h.costMutations.length,2000);assert.equal(h.mutations.length,0);assert.equal(s.job.completed,2000);assert.equal(s.audit.length,2000);assert.ok(s.audit.every(a=>a.status==='success'&&a.kind==='cost'));assert.equal(variants[1999].inventoryItem.unitCost.amount,'54.00');
});
