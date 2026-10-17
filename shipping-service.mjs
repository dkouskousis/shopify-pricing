import { randomBytes } from 'node:crypto';
import { shippingRates, shippingFingerprint, shippingUpdate, adjustedShippingPrice, SHIPPING_QUERIES } from './shipping.mjs';
import { validateDhlSettings, validateShipment, createDhl } from './dhl.mjs';
const token = () => randomBytes(32).toString('hex');
export function createShippingService({ store, graphql, startJob, jobState, safeError, stopping, makeDhl = createDhl }) {
  const { db } = store, quotes = new Map(), plans = new Map();
  const dhlSettings = () => { const value = store.get('dhlSettings'); return value ? store.decrypt(value) : null; };
  dhlSettings();
  function state() {
    const d = dhlSettings(), { password, ...safe } = d ?? {};
    for (const [id, q] of quotes) if (Date.now() - Date.parse(q.at) > 15 * 60000) quotes.delete(id);
    for (const [id, p] of plans) if (p.expires < Date.now()) plans.delete(id);
    return { dhl: d ? { ...safe, hasPassword: Boolean(password) } : null, lastSync: store.get('shippingSync'),
      rows: (store.get('shippingRates') ?? []).map(r => ({ ...r, sample: store.get('shippingSamples')?.[r.id] ?? null, quote: quotes.get(r.id) ?? null })) };
  }
  const cachedRow = id => { const r = (store.get('shippingRates') ?? []).find(r => r.id === id); if (!r) throw new Error('Δεν βρέθηκε η κλίμακα. Κάνε συγχρονισμό μεταφορικών.'); return r; };
  async function freshRow(row) {
    return (await shippingRates(graphql(), { id: row.profileId, name: row.profileName, profileLocationGroups: [{ locationGroup: { id: row.groupId } }] })).find(r => r.id === row.id);
  }
  async function apply(plan) {
    const job = jobState(); job.total = plan.items.length; let success = 0, failed = 0;
    for (const item of plan.items) {
      if (stopping()) break;
      const audit = db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail,kind) VALUES (?,?,?,?,?,?,?,?)')
        .run(new Date().toISOString(), item.id, item.title, item.oldPrice, item.newPrice, 'pending', 'Μεταφορικά', 'shipping');
      let sending = false;
      try {
        const fresh = await freshRow(item.row);
        if (!fresh || !fresh.editable || shippingFingerprint(fresh) !== item.fingerprint) throw new Error('Η κλίμακα άλλαξε στο Shopify. Συγχρόνισε ξανά πριν την ενημέρωση.');
        sending = true;
        const payload = (await graphql()(SHIPPING_QUERIES.update, shippingUpdate(fresh, item.newPrice))).deliveryProfileUpdate;
        if (payload.userErrors.length) { sending = false; throw new Error(payload.userErrors.map(e => e.message).join('; ')); }
        const confirmed = await freshRow(fresh);
        if (!confirmed || confirmed.price !== item.newPrice || shippingFingerprint({ ...confirmed, price: fresh.price }) !== item.fingerprint) throw new Error('Δεν επιβεβαιώθηκε η αποθήκευση χωρίς αλλαγή όρων. Συγχρόνισε και έλεγξε το Shopify.');
        store.put('shippingRates', (store.get('shippingRates') ?? []).map(r => r.id === item.id ? confirmed : r));
        db.prepare("UPDATE audit SET status='success',detail='Μεταφορικά' WHERE id=?").run(audit.lastInsertRowid); success++;
      } catch (e) {
        db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending ? 'uncertain' : 'failed', safeError(e), audit.lastInsertRowid); failed++;
      }
      job.completed++;
    }
    job.message = `Μεταφορικά: ${success} ενημερώθηκαν, ${failed} χρειάζονται έλεγχο.${stopping() ? ' Η εργασία διακόπηκε λόγω επανεκκίνησης.' : ''}`;
  }
  function checkSample(row, sample) {
    if (!row.countries.some(c => c.code.restOfWorld || c.code.countryCode === sample.destinationCountryCode)) throw new Error('Η χώρα δείγματος δεν ανήκει στη ζώνη.');
    const kg = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523125 };
    for (const condition of row.conditions.filter(c => c.field === 'TOTAL_WEIGHT')) {
      const value = condition.conditionCriteria, factor = kg[value.unit];
      if (!factor) throw new Error('Μη υποστηριζόμενη μονάδα βάρους κλίμακας.');
      const limit = value.value * factor;
      if (condition.operator === 'GREATER_THAN_OR_EQUAL_TO' ? sample.weight + 1e-9 < limit : sample.weight - 1e-9 > limit) throw new Error('Το βάρος δείγματος βρίσκεται εκτός ορίων της κλίμακας.');
    }
  }
  async function handle(path, input) {
    if (path === '/api/dhl/settings') {
      const s = validateDhlSettings(input, dhlSettings() ?? {});
      store.put('dhlSettings', store.encrypt(s)); quotes.clear(); plans.clear(); return { ok: true };
    }
    if (path === '/api/shipping/sync') {
      startJob('shipping-sync', async () => {
        const rows = await shippingRates(graphql());
        store.put('shippingRates', rows); store.put('shippingSync', new Date().toISOString()); quotes.clear(); plans.clear();
        jobState().message = `Συγχρονίστηκαν ${rows.length} κλίμακες μεταφορικών.`;
      }); return { ok: true };
    }
    if (path === '/api/shipping/sample') {
      const row = cachedRow(input.id), sample = validateShipment(input.sample);
      checkSample(row, sample);
      store.put('shippingSamples', { ...(store.get('shippingSamples') ?? {}), [row.id]: sample }); quotes.delete(row.id); plans.clear(); return { ok: true };
    }
    if (path === '/api/shipping/quote') {
      const row = cachedRow(input.id), s = dhlSettings(), sample = store.get('shippingSamples')?.[row.id];
      if (!s) throw new Error('Συμπλήρωσε πρώτα το DHL Express στο Ρυθμίσεις → Integrations.');
      if (!sample) throw new Error('Όρισε πρώτα δείγμα αποστολής στην κλίμακα.');
      checkSample(row, validateShipment(sample));
      quotes.delete(row.id); plans.clear();
      const quote = await makeDhl(s)(sample);
      quotes.set(row.id, quote); return { ok: true, quote };
    }
    if (path === '/api/shipping/preview') {
      if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 2000 || new Set(input.ids).size !== input.ids.length) throw new Error('Επίλεξε 1–2.000 διαφορετικές κλίμακες.');
      if (!['current','dhl'].includes(input.base)) throw new Error('Επίλεξε βάση υπολογισμού.');
      const items = input.ids.map(id => {
        const row = cachedRow(id); if (!row.editable) throw new Error('Υποστηρίζονται μόνο σταθερές χρεώσεις EUR.');
        if (row.price === 0 && !input.includeFree) throw new Error('Η επιλογή περιέχει δωρεάν χρέωση. Ενεργοποίησε τη σχετική επιλογή ή αφαίρεσέ την.');
        let base = row.price;
        if (input.base === 'dhl') {
          const quote = quotes.get(id);
          if (!quote || Date.now() - Date.parse(quote.at) > 15 * 60000) throw new Error('Λείπει πρόσφατη προσφορά DHL για κάποια κλίμακα.');
          if (quote.environment !== 'live') throw new Error('Οι δοκιμαστικές τιμές DHL δεν εφαρμόζονται στο Shopify. Επίλεξε Production στο Integration.');
          const service = quote.products.filter(p => p.code === input.serviceCode);
          if (service.length !== 1) throw new Error('Η επιλεγμένη υπηρεσία DHL δεν υπάρχει μοναδικά σε όλες τις κλίμακες.');
          base = service[0].price;
        }
        const newPrice = adjustedShippingPrice(base, input.kind, input.value);
        return { id, title: `${row.profileName} / ${row.zoneName} / ${row.name}`, oldPrice: row.price, newPrice, row, fingerprint: shippingFingerprint(row) };
      }).filter(i => i.oldPrice !== i.newPrice);
      if (!items.length) throw new Error('Δεν προκύπτει αλλαγή τιμής.');
      const id = token(), expires = Date.now() + 15 * 60000;
      plans.clear(); plans.set(id, { items, expires });
      return { id, expires, items: items.map(({ row, fingerprint, ...i }) => i) };
    }
    if (path === '/api/shipping/apply') {
      const plan = plans.get(input.id); plans.delete(input.id);
      if (!plan || plan.expires < Date.now()) throw new Error('Η προεπισκόπηση έληξε ή χρησιμοποιήθηκε. Κάνε νέα προεπισκόπηση.');
      startJob('shipping-apply', () => apply(plan)); return { ok: true };
    }
    throw new Error('Άγνωστη ενέργεια μεταφορικών.');
  }
  return { state, handle };
}
