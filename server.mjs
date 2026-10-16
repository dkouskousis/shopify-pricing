import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import { decimal, money, validateRule, calculate } from './pricing.mjs';
import { QUERIES, validateSettings, createShopify, collectionPages, productCollectionIds } from './shopify.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const random = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function fingerprint(v) {
  return JSON.stringify([v.price, v.cost, v.currency, v.vendor, v.status, v.taxable, v.compareAt, v.collectionIds]);
}
function normalize(v) {
  return { id: v.id, productId: v.product.id, title: v.product.title, variant: v.title,
    vendor: v.product.vendor, status: v.product.status, sku: v.inventoryItem.sku || '',
    price: decimal(v.price), compareAt: v.compareAtPrice === null ? null : decimal(v.compareAtPrice), taxable: v.taxable,
    cost: v.inventoryItem.unitCost === null ? null : decimal(v.inventoryItem.unitCost.amount),
    currency: v.inventoryItem.unitCost?.currencyCode ?? null };
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('Απαιτείται JSON.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) fail('Πολύ μεγάλο αίτημα.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Μη έγκυρο JSON.'); }
}

export function createApplication(config, dependencies = {}) {
  const appUrl = new URL(config.appUrl);
  if (appUrl.pathname !== '/' || appUrl.search || appUrl.hash || !['http:', 'https:'].includes(appUrl.protocol)) throw new Error('APP_URL must be an http(s) origin without a path.');
  if (appUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(appUrl.hostname)) throw new Error('Use HTTPS for APP_URL outside localhost.');
  if (typeof config.password !== 'string' || config.password.length < 16) throw new Error('APP_PASSWORD must contain at least 16 characters.');
  const passwordSalt = randomBytes(16), passwordHash = scryptSync(config.password, passwordSalt, 64);
  const store = openStore(config.dbPath, config.encryptionKey), { db } = store;
  // Fail early if an existing database cannot be decrypted with this key.
  store.settings();
  const authMarker = createHmac('sha256', Buffer.from(config.encryptionKey, 'hex')).update(config.password).digest('hex');
  if (store.get('authMarker') !== authMarker) { db.exec('DELETE FROM sessions'); store.put('authMarker', authMarker); }
  const makeShopify = dependencies.makeShopify ?? createShopify;
  let client = null, shuttingDown = false, costSaving = false, job = { running: false, type: null, completed: 0, total: 0, message: '', error: null };
  const attempts = new Map();
  const cookie = (value, maxAge) => `pricing_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${appUrl.protocol === 'https:' ? '; Secure' : ''}`;
  function graphql() {
    if (!client) { const settings = store.settings(); if (!settings) fail('Συμπλήρωσε πρώτα τις ρυθμίσεις Shopify.'); client = makeShopify(settings); }
    return client;
  }
  function invalidate() { db.exec('DELETE FROM previews'); }
  function safeError(error) {
    let message = String(error.message || 'Παρουσιάστηκε σφάλμα.');
    const s = store.settings();
    for (const secret of [s?.clientSecret, s?.accessToken, config.password]) if (secret) message = message.replaceAll(secret, '[hidden]');
    return message.slice(0, 1000);
  }
  function startJob(type, work) {
    if (job.running) fail('Εκτελείται ήδη εργασία.', 409);
    job = { running: true, type, completed: 0, total: 0, message: '', error: null };
    Promise.resolve().then(work).catch(error => { job.error = safeError(error); }).finally(() => { job.running = false; });
  }
  function resultFor(v) {
    const rule = store.rules().find(r => r.vendor === v.vendor);
    const result = calculate(v.cost, rule, v.taxable, v.collectionIds);
    if (v.currency && v.currency !== 'EUR') return { ...v, result: { error: 'Το κόστος δεν είναι σε EUR.' } };
    if (v.status === 'ARCHIVED') return { ...v, result: { error: 'Αρχειοθετημένο προϊόν.' } };
    if (!result.error && v.compareAt !== null && v.compareAt > 0 && result.final >= v.compareAt) result.error = 'Η προτεινόμενη τιμή φτάνει/ξεπερνά την Compare-at price. Έλεγξέ την πρώτα στο Shopify.';
    if (!result.error && result.final <= 0) result.error = 'Η τελική τιμή πρέπει να είναι θετική.';
    return { ...v, result };
  }
  async function sync() {
    const api = graphql(), info = (await api(QUERIES.shop)).shop;
    if (info.currencyCode !== 'EUR') fail('Η έκδοση αυτή υποστηρίζει καταστήματα με βασικό νόμισμα EUR.');
    let after = null, all = [];
    do {
      const { productVariants: page } = await api(QUERIES.variants, { after });
      all.push(...page.nodes.map(normalize));
      job.completed = all.length;
      if (all.length > 25000) fail('Υπέρβαση ορίου 25.000 παραλλαγών.');
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !after) fail('Λείπει ο cursor σελιδοποίησης του Shopify.');
    } while (after);
    const collections = await collectionPages(async after => (await api(QUERIES.collections, { after })).collections);
    const ids = [...new Set(all.map(v => v.productId))], memberships = new Map();
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const { nodes } = await api(QUERIES.memberships, { ids: batch });
      for (const id of batch) {
        const product = nodes.find(p => p?.id === id);
        if (!product) fail('Προϊόν άλλαξε κατά τον συγχρονισμό. Δοκίμασε νέο συγχρονισμό.');
        memberships.set(id, await productCollectionIds(api, id, product.collections));
      }
    }
    all = all.map(v => ({ ...v, collectionIds: memberships.get(v.productId) }));
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM variants');
      const insert = db.prepare('INSERT INTO variants VALUES (?,?)');
      for (const v of all) insert.run(v.id, JSON.stringify(v));
      store.put('collections', collections.sort((a, b) => a.title.localeCompare(b.title)));
      store.put('shopInfo', info); store.put('lastSync', new Date().toISOString()); invalidate();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    job.message = `Συγχρονίστηκαν ${all.length} παραλλαγές.`;
  }
  async function apply(plan) {
    const api = graphql();
    job.total = plan.items.length;
    let success = 0, failed = 0;
    for (const item of plan.items) {
      if (shuttingDown) break;
      const audit = db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail) VALUES (?,?,?,?,?,?,?)')
        .run(new Date().toISOString(), item.id, item.title, item.oldPrice, item.newPrice, 'pending', '');
      let sending = false;
      try {
        const fresh = (await api(QUERIES.check, { id: item.id })).productVariant;
        if (!fresh) fail('Η παραλλαγή δεν υπάρχει πλέον.');
        const cached = store.variant(item.id);
        const current = { ...cached, price: decimal(fresh.price), compareAt: fresh.compareAtPrice === null ? null : decimal(fresh.compareAtPrice),
          cost: fresh.inventoryItem.unitCost === null ? null : decimal(fresh.inventoryItem.unitCost.amount),
          currency: fresh.inventoryItem.unitCost?.currencyCode ?? null, taxable: fresh.taxable,
          vendor: fresh.product.vendor, status: fresh.product.status };
        const rule = store.rules().find(r => r.vendor === cached.vendor);
        if (rule.conditions.some(c => c.collectionId)) current.collectionIds = await productCollectionIds(api, item.productId);
        if (fresh.product.id !== item.productId || fingerprint(current) !== item.fingerprint) fail('Άλλαξαν τιμή, κόστος, collections ή στοιχεία στο Shopify. Συγχρόνισε και κάνε νέα προεπισκόπηση.');
        sending = true;
        const payload = (await api(QUERIES.update, { productId: item.productId, variants: [{ id: item.id, price: money(item.newPrice) }] })).productVariantsBulkUpdate;
        if (payload.userErrors.length) { sending = false; fail(payload.userErrors.map(e => e.message).join('; ')); }
        const updated = payload.productVariants.find(v => v.id === item.id);
        if (!updated || decimal(updated.price) !== item.newPrice) fail('Δεν επιβεβαιώθηκε η αποθήκευση της νέας τιμής. Συγχρόνισε και έλεγξε το Shopify.');
        db.prepare('INSERT OR REPLACE INTO variants VALUES (?,?)').run(item.id, JSON.stringify({ ...cached, price: item.newPrice }));
        db.prepare("UPDATE audit SET status='success',detail='' WHERE id=?").run(audit.lastInsertRowid);
        success++;
      } catch (error) {
        db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending ? 'uncertain' : 'failed', safeError(error), audit.lastInsertRowid);
        failed++;
      }
      job.completed++;
    }
    job.message = `${success} ενημερώσεις ολοκληρώθηκαν, ${failed} χρειάζονται έλεγχο.${shuttingDown ? ' Η εργασία σταμάτησε λόγω επανεκκίνησης.' : ''} Δες το ιστορικό.`;
  }

  const server = http.createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
    };
    const json = (data, status = 200, more = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...more }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, appUrl);
      if (req.method === 'GET' && url.pathname === '/healthz') return json({ ok: true });
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin !== appUrl.origin) fail('Μη αποδεκτή προέλευση αιτήματος. Έλεγξε το APP_URL.', 403);
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        const rate = attempts.get(ip) ?? { count: 0, until: now + 15 * 60000 };
        if (rate.count >= 10) fail('Πολλές προσπάθειες. Δοκίμασε σε 15 λεπτά.', 429);
        const input = await body(req);
        if (typeof input.password !== 'string' || input.password.length > 1024) fail('Μη έγκυρος κωδικός.', 401);
        if (!timingSafeEqual(scryptSync(input.password, passwordSalt, 64), passwordHash)) {
          attempts.set(ip, { ...rate, count: rate.count + 1 }); fail('Λάθος κωδικός.', 401);
        }
        attempts.delete(ip);
        const session = random();
        db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(session), random(), now + 8 * 3600000);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie(session, 8 * 3600) });
      }
      if (url.pathname.startsWith('/api/')) {
        const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pricing_session='))?.slice(16);
        const session = raw ? db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(raw), Date.now()) : null;
        if (!session) fail('Χρειάζεται σύνδεση.', 401);
        if (req.method !== 'GET' && !same(req.headers['x-csrf-token'] ?? '', session.csrf)) fail('Μη έγκυρο αίτημα. Ανανέωσε τη σελίδα.', 403);
        if (req.method === 'POST' && url.pathname === '/api/logout') { db.prepare('DELETE FROM sessions WHERE id=?').run(session.id); return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const s = store.settings();
          return json({ csrf: session.csrf, job: { ...job, costSaving }, lastSync: store.get('lastSync'), shopInfo: store.get('shopInfo'),
            settings: s ? { shop: s.shop, mode: s.mode, clientId: s.clientId, hasClientSecret: Boolean(s.clientSecret), hasAccessToken: Boolean(s.accessToken) } : null,
            rules: store.rules(), collections: store.get('collections'), vendors: [...new Set(store.variants().map(v => v.vendor))].sort(),
            products: store.variants().map(resultFor), audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() });
        }
        if (req.method !== 'POST') fail('Δεν βρέθηκε.', 404);
        const input = await body(req);
        if (job.running || costSaving || shuttingDown) fail('Περίμενε να ολοκληρωθεί η τρέχουσα εργασία.', 409);
        if (url.pathname === '/api/settings') {
          store.saveSettings(validateSettings(input, store.settings() ?? {})); client = null; invalidate(); return json({ ok: true });
        }
        if (url.pathname === '/api/settings/test') {
          const info = (await graphql()(QUERIES.shop)).shop;
          // Also verifies product AND inventory-cost permissions, not just the shop name.
          await graphql()(QUERIES.variants, { after: null });
          if (info.currencyCode !== 'EUR') fail('Απαιτείται βασικό νόμισμα EUR.');
          return json({ ok: true, shop: info });
        }
        if (url.pathname === '/api/rules') {
          const rule = validateRule(input);
          if (rule.conditions.some(c => c.collectionId && !store.get('collections').some(collection => collection.id === c.collectionId))) fail('Το collection δεν υπάρχει στον τελευταίο συγχρονισμό. Συγχρόνισε Shopify ή αφαίρεσέ το από τον όρο.');
          db.prepare('INSERT OR REPLACE INTO rules VALUES (?,?)').run(rule.vendor, JSON.stringify(rule)); invalidate(); return json({ ok: true });
        }
        if (url.pathname === '/api/rules/delete') { db.prepare('DELETE FROM rules WHERE vendor=?').run(String(input.vendor)); invalidate(); return json({ ok: true }); }
        if (url.pathname === '/api/cost') {
          const cached = store.variant(input.id);
          if (!cached) fail('Δεν βρέθηκε η παραλλαγή.');
          const amount = decimal(input.cost, 'Τιμή αγοράς');
          if (input.expectedCost !== cached.cost) fail('Το κόστος έχει αλλάξει. Ανανέωσε τη λίστα και δοκίμασε ξανά.', 409);
          if (amount === cached.cost) return json({ ok: true, unchanged: true });
          const audit = db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail,kind,old_missing) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(new Date().toISOString(), cached.id, `${cached.title} / ${cached.variant}`, cached.cost ?? 0, amount, 'pending', '', 'cost', cached.cost === null ? 1 : 0);
          costSaving = true;
          let sending = false;
          try {
            const api = graphql();
            const fresh = (await api(QUERIES.check, { id: cached.id })).productVariant;
            if (!fresh || fresh.product.id !== cached.productId) fail('Η παραλλαγή δεν υπάρχει πλέον ή άλλαξε προϊόν.');
            const oldCost = fresh.inventoryItem.unitCost === null ? null : decimal(fresh.inventoryItem.unitCost.amount);
            if (oldCost !== cached.cost) fail('Το κόστος άλλαξε στο Shopify. Κάνε συγχρονισμό πριν το αντικαταστήσεις.', 409);
            if (fresh.inventoryItem.unitCost && fresh.inventoryItem.unitCost.currencyCode !== 'EUR') fail('Το κόστος δεν είναι σε EUR.');
            sending = true;
            const payload = (await api(QUERIES.updateCost, { id: fresh.inventoryItem.id, input: { cost: money(amount) } })).inventoryItemUpdate;
            if (payload.userErrors.length) { sending = false; fail(payload.userErrors.map(e => e.message).join('; ')); }
            if (payload.inventoryItem?.id !== fresh.inventoryItem.id || !payload.inventoryItem.unitCost
              || payload.inventoryItem.unitCost.currencyCode !== 'EUR' || decimal(payload.inventoryItem.unitCost.amount) !== amount) fail('Δεν επιβεβαιώθηκε η ενημέρωση κόστους. Συγχρόνισε και έλεγξε το Shopify πριν ξαναδοκιμάσεις.');
            const readback = (await api(QUERIES.check, { id: cached.id })).productVariant;
            if (!readback || readback.inventoryItem.id !== fresh.inventoryItem.id || !readback.inventoryItem.unitCost
              || readback.inventoryItem.unitCost.currencyCode !== 'EUR' || decimal(readback.inventoryItem.unitCost.amount) !== amount) fail('Δεν επιβεβαιώθηκε η νέα τιμή αγοράς με επανέλεγχο. Συγχρόνισε και έλεγξε το Shopify.');
            db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({ ...cached, cost: amount, currency: 'EUR' }), cached.id);
            invalidate();
            db.prepare("UPDATE audit SET status='success',detail='' WHERE id=?").run(audit.lastInsertRowid);
            return json({ ok: true, cost: amount });
          } catch (error) {
            invalidate();
            db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending ? 'uncertain' : 'failed', safeError(error), audit.lastInsertRowid);
            if (sending) fail(`Το αποτέλεσμα της ενημέρωσης κόστους είναι αβέβαιο. Κάνε συγχρονισμό και έλεγξε το Shopify πριν ξαναδοκιμάσεις. ${safeError(error)}`);
            throw error;
          } finally { costSaving = false; }
        }
        if (url.pathname === '/api/sync') { startJob('sync', sync); return json({ ok: true }, 202); }
        if (url.pathname === '/api/preview') {
          if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || new Set(input.ids).size !== input.ids.length) fail('Επίλεξε 1–100 διαφορετικές παραλλαγές.');
          const items = input.ids.map(id => {
            const v = store.variant(id); if (!v) fail('Δεν βρέθηκε η παραλλαγή.');
            const { result } = resultFor(v); if (result.error) fail(`${v.title}: ${result.error}`);
            if (v.price === result.final) fail(`${v.title}: η τιμή δεν αλλάζει.`);
            return { id, productId: v.productId, title: `${v.title} / ${v.variant}`, oldPrice: v.price, newPrice: result.final,
              profit: result.profit, margin: result.margin, fingerprint: fingerprint(v) };
          });
          const id = random(), expires = Date.now() + 15 * 60000;
          db.prepare('DELETE FROM previews WHERE expires<? OR consumed=1').run(Date.now());
          db.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run(id, JSON.stringify({ items }), expires);
          return json({ id, expires, items });
        }
        if (url.pathname === '/api/apply') {
          const preview = db.prepare('SELECT * FROM previews WHERE id=? AND consumed=0 AND expires>?').get(String(input.id), Date.now());
          if (!preview) fail('Η προεπισκόπηση έληξε ή έχει ήδη χρησιμοποιηθεί. Κάνε νέα προεπισκόπηση.', 409);
          const plan = JSON.parse(preview.data);
          db.prepare('UPDATE previews SET consumed=1 WHERE id=?').run(preview.id);
          startJob('apply', () => apply(plan)); return json({ ok: true }, 202);
        }
        fail('Δεν βρέθηκε.', 404);
      }
      const paths = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/product-filters.mjs': ['product-filters.mjs', 'text/javascript'], '/pricing.mjs': ['pricing.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && paths[url.pathname]) {
        const [file, type] = paths[url.pathname];
        res.writeHead(200, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
        return res.end(readFileSync(resolve(root, 'public', file)));
      }
      fail('Δεν βρέθηκε.', 404);
    } catch (error) { if (!res.headersSent) json({ error: safeError(error) }, error.status ?? 400); else res.end(); }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return { server, store, close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })),
    async shutdown() {
      shuttingDown = true;
      server.close();
      while (job.running || costSaving) await new Promise(resolve => setTimeout(resolve, 100));
      db.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication({ appUrl: process.env.APP_URL, password: process.env.APP_PASSWORD,
    encryptionKey: process.env.ENCRYPTION_KEY, dbPath: process.env.DB_PATH || '/data/pricing.sqlite' });
  app.server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Shopify Pricing listening on port ' + (process.env.PORT || 3000)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    // Finish the current variant, but do not start another one during shutdown.
    app.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 40000).unref();
  });
}
