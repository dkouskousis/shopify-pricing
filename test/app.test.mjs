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
    product: { id: 'gid://shopify/Product/9', title: 'Test product ' + n, vendor: 'Example', status: 'ACTIVE' } };
}
async function harness(t, variants = [variant(1)]) {
  let mutations = [], costMutations = [], pages = 0, pageError = false, mutationError = false, costFailure = null;
  const api = async (query, variables) => {
    if (query.includes('ShopInfo')) return { shop: { name: 'Test shop', myshopifyDomain: 'example.myshopify.com', currencyCode: 'EUR' } };
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
    assert.equal((await request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1.55', vat: '24', addVat: true })).status, 200);
    assert.equal((await request('sync', {})).status, 202); await idle();
  }
  return { app, request, setup, login, idle, mutations, costMutations, setCostFailure: value => { costFailure = value; }, setPageError: () => { pageError = true; }, setMutationError: () => { mutationError = true; }, pages: () => pages };
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
  assert.equal(preview.data.items[0].newPrice, 11532);
  assert.equal(h.mutations.length, 0);
  assert.equal((await h.request('apply', { id: preview.data.id, price: 1 })).status, 202);
  const state = await h.idle();
  assert.equal(h.mutations.length, 1);
  assert.deepEqual(h.mutations[0].variants, [{ id: id(1), price: '115.32' }]);
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
  await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1.60', vat: '24', addVat: true });
  assert.equal((await h.request('apply', { id: p.id })).status, 409);
  assert.equal((await h.request('state')).data.products[0].result.final, 11904);
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
  await h.request('rules', { vendor: 'Example', mode: 'multiplier', multiplier: '1.60', vat: '24', addVat: true });
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
  assert.equal(state.products.find(v => v.id === id(1)).result.final, 12493);
  assert.equal(state.audit[0].kind, 'cost');
  assert.equal(state.audit[0].status, 'success');
  assert.equal((await h.request('apply', { id: preview.id })).status, 409);
});
test('missing purchase cost can be filled from the product list', async t => {
  const h = await harness(t, [variant(1, '100', null)]); await h.setup();
  assert.equal((await h.request('cost', { id: id(1), cost: '60', expectedCost: null })).status, 200);
  const s = (await h.request('state')).data;
  assert.equal(s.products[0].result.final, 11532);
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
  const result = await h.request('rules', { vendor: 'Example', mode: 'margin', targetMargin: '40', vat: '24', addVat: true });
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
  assert.equal(after.products[0].result.final, 13433);
  assert.equal(after.products[0].result.margin, 40);
});
