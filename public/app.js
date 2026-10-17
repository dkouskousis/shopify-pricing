import { decimal, validateRule, calculate } from './pricing.mjs';
import { shippingUI } from './shipping-ui.mjs';
import { filterProducts } from './product-filters.mjs';
const $ = selector => document.querySelector(selector);
const euros = cents => cents === null || cents === undefined ? '—' : new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const pct = number => new Intl.NumberFormat('el-GR', { maximumFractionDigits: 2 }).format(number) + '%';
const date = value => value ? new Date(value).toLocaleString('el-GR') : '—';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null, selected = new Set(), page = 0, preview = null, timer = null, settingsDirty = false;
let notificationTimer, costEdit = null, costPending = false;
let priceEdit = null, pricePending = false;
function notify(message, error = false) {
  $('#notice').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false;
  clearTimeout(notificationTimer); notificationTimer = setTimeout(() => { $('#notice').hidden = true; }, error ? 15000 : 7000);
}
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf ?? '' },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401) { clearTimeout(timer); $('#workspace').hidden = true; $('#login').hidden = false; state = null; }
  if (!response.ok) throw new Error(result.error || 'Το αίτημα απέτυχε.');
  return result;
}
async function action(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; if (state) updateSelection(); }
}
function tab(name) {
  document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== name; });
  document.querySelectorAll('nav button').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
}
function filtered() {
  return filterProducts(state.products, {
    search: $('#search').value, vendor: $('#vendor').value, change: $('#filter').value,
    status: $('#status-filter').value, price: $('#price-filter').value, cost: $('#cost-filter').value,
  });
}
function eligible(p) { return !p.result.error && p.result.final !== p.price; }
function updateSelection() {
  $('#selection-count').textContent = `${selected.size} επιλεγμένες`;
  $('#preview').disabled = !selected.size || Boolean(state?.job.running || state?.job.costSaving || state?.job.priceSaving);
}
function renderProducts() {
  const all = filtered(), pageCount = Math.max(1, Math.ceil(all.length / 50));
  page = Math.min(page, pageCount - 1);
  const visible = all.slice(page * 50, page * 50 + 50);
  $('#product-rows').innerHTML = visible.length ? visible.map(p => {
    const rule = state.rules.find(r => r.vendor === p.vendor);
    const gainPercent = rule ? (rule.mode === 'margin' ? rule.targetMargin / (10000 - rule.targetMargin) * 100 : (rule.multiplier - 10000) / 100) : null;
    const vatPercent = rule ? (rule.addVat ? rule.vat / 100 : 0) : null;
    const direction = !p.result.error && p.result.final !== p.price ? (p.result.final > p.price ? 'up' : 'down') : '';
    const priceChange = direction ? `${direction === 'up' ? 'Αύξηση' : 'Μείωση'} κατά ${euros(Math.abs(p.result.final - p.price))}` : '';
    return `<tr>
    <td><input type="checkbox" data-select="${escape(p.id)}" aria-label="Επιλογή ${escape(p.title)} ${escape(p.variant)}" title="${escape(p.result.error || (p.result.final === p.price ? 'Η τιμή είναι ήδη ενημερωμένη.' : 'Επιλογή για ενημέρωση τιμής.'))}" ${selected.has(p.id) ? 'checked' : ''} ${eligible(p) ? '' : 'disabled'}></td>
    <td><div class="product-cell">${p.image ? `<button class="product-thumbnail" data-image="${escape(p.id)}" aria-label="Μεγέθυνση φωτογραφίας: ${escape(p.title)}"><img src="${escape(p.image.thumbnail)}" alt="${escape(p.image.altText || p.title)}" width="32" height="32" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>` : '<span class="product-thumbnail-empty" title="Χωρίς φωτογραφία" aria-label="Χωρίς φωτογραφία">—</span>'}<div><span class="product-title">${escape(p.title)}</span><small>${escape(p.variant)} · ${escape(p.vendor)}<br>SKU: ${escape(p.sku || '—')} · ${escape(p.status)}</small>${p.result.error ? `<small class="negative">${escape(p.result.error)}</small>` : ''}</div></div></td>
    <td class="number"><button class="quiet cost-button" data-cost="${escape(p.id)}" aria-label="Αλλαγή κόστους για ${escape(p.title)} ${escape(p.variant)}" ${state.job.running || state.job.costSaving || state.job.priceSaving ? 'disabled' : ''}>${p.cost === null ? 'Προσθήκη κόστους' : euros(p.cost)}</button></td>
    <td class="number"><button class="quiet cost-button" data-price="${escape(p.id)}" aria-label="Αλλαγή τιμής πώλησης για ${escape(p.title)} ${escape(p.variant)}" ${state.job.running || state.job.costSaving || state.job.priceSaving ? 'disabled' : ''}>${euros(p.price)}</button>${p.compareAt ? `<small>Compare-at: ${euros(p.compareAt)}</small>` : ''}</td>
    <td class="number new-price ${direction ? 'price-' + direction : ''}" title="${escape(priceChange)}">${direction ? `<span aria-hidden="true">${direction === 'up' ? '↑' : '↓'}</span> ` : ''}${p.result.error ? '—' : euros(p.result.final)}${!p.result.error && p.result.final === p.price ? '<small>Ήδη ενημερωμένη</small>' : ''}</td>
    <td class="number ${gainPercent < 0 ? 'negative' : ''}">${gainPercent === null ? '—' : pct(gainPercent)}${rule?.mode === 'margin' ? `<small>Στόχος περιθωρίου ${pct(rule.targetMargin / 100)}</small>` : ''}</td>
    <td class="number">${rule ? (p.result.error ? '—' : euros(p.result.fixed)) : euros(0)}</td>
    <td class="number">${vatPercent === null ? '—' : pct(vatPercent)}</td>
    <td class="number ${p.result.profit < 0 ? 'negative' : ''}">${p.result.error ? '—' : euros(p.result.profit)}</td>
    <td class="number ${p.result.margin < 0 ? 'negative' : ''}">${p.result.error ? '—' : pct(p.result.margin)}</td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">Δεν υπάρχουν προϊόντα. Κάνε συγχρονισμό ή άλλαξε τα φίλτρα.</td></tr>';
  $('#page-label').textContent = `Σελίδα ${page + 1} / ${pageCount} · ${all.length} παραλλαγές`;
  $('#previous').disabled = page === 0; $('#next').disabled = page >= pageCount - 1;
  const selectable = visible.filter(eligible);
  $('#select-page').checked = selectable.length > 0 && selectable.every(p => selected.has(p.id));
  $('#select-page').indeterminate = selectable.some(p => selected.has(p.id)) && !$('#select-page').checked;
  updateSelection();
}
function renderRules() {
  $('#vendors-list').innerHTML = state.vendors.map(v => `<option value="${escape(v)}"></option>`).join('');
  $('#rule-list').innerHTML = state.rules.length ? state.rules.map(r => `<div class="rule-card"><div><strong>${escape(r.vendor)}</strong><p><span class="rule-type">${r.mode === 'margin' ? 'Περιθώριο ' + pct(r.targetMargin / 100) : 'Συντελεστής ×' + escape(new Intl.NumberFormat('el-GR', { maximumFractionDigits: 4 }).format(r.multiplier / 10000))}</span> · ${r.addVat ? 'με προσθήκη ΦΠΑ ' + pct(r.vat / 100) : 'χωρίς προσθήκη ΦΠΑ'}</p></div><div class="actions"><button class="quiet" data-edit-rule="${escape(r.vendor)}">Επεξεργασία</button><button class="quiet" data-delete-rule="${escape(r.vendor)}" aria-label="Διαγραφή κανόνα ${escape(r.vendor)}">×</button></div></div>`).join('') : '<p class="muted">Δεν έχουν οριστεί κανόνες.</p>';
  for (const card of document.querySelectorAll('.rule-card')) {
    const rule = state.rules.find(r => r.vendor === card.querySelector('[data-edit-rule]').dataset.editRule);
    if (rule.conditions.length) card.querySelector('div').insertAdjacentHTML('beforeend', `<ul class="condition-summary">${rule.conditions.map(c => `<li>${euros(c.from)}–${euros(c.to)} · ${escape(c.collectionId ? state.collections.find(x => x.id === c.collectionId)?.title ?? 'Collection δεν βρέθηκε' : 'Όλα τα collections')} · +${euros(c.amount)} πριν τον ΦΠΑ</li>`).join('')}</ul>`);
  }
  const missing = state.vendors.filter(v => !state.rules.some(r => r.vendor === v));
  $('#unconfigured').innerHTML = missing.length ? missing.map(v => `<button class="quiet" data-new-rule="${escape(v)}">${escape(v || '(κενό Vendor στο Shopify)')}</button>`).join(' ') : '<p class="muted">Όλοι οι συγχρονισμένοι προμηθευτές έχουν κανόνα.</p>';
}
function renderSettings() {
  const form = $('#settings-form'), s = state.settings;
  if (!settingsDirty && s) { form.elements.shop.value = s.shop; form.elements.mode.value = s.mode; form.elements.clientId.value = s.clientId; }
  $('#credentials-state').textContent = s ? `Αποθηκευμένο Client secret: ${s.hasClientSecret ? 'ναι' : 'όχι'} · Access token: ${s.hasAccessToken ? 'ναι' : 'όχι'}. Κενό πεδίο μυστικού διατηρεί την αποθηκευμένη τιμή.` : 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης.';
  authFields();
}
function authFields() {
  const clientMode = $('#settings-form').elements.mode.value === 'client_credentials';
  $('#client-fields').hidden = !clientMode; $('#token-fields').hidden = clientMode;
}
async function load() {
  clearTimeout(timer); const wasRunning = state?.job.running;
  state = await api('state');
  $('#login').hidden = true; $('#workspace').hidden = false;
  $('#shop-label').textContent = state.shopInfo?.name ?? state.settings?.shop ?? 'Ρύθμισε τη σύνδεση Shopify για να ξεκινήσεις.';
  $('#sync-time').textContent = state.lastSync ? 'Τελευταίος συγχρονισμός: ' + date(state.lastSync) : 'Δεν έχει γίνει συγχρονισμός.';
  $('#count').textContent = state.products.length;
  $('#changes').textContent = state.products.filter(eligible).length;
  $('#missing').textContent = state.products.filter(p => p.result.error).length;
  const vendor = $('#vendor').value;
  $('#vendor').innerHTML = '<option value="">Όλοι οι προμηθευτές</option>' + state.vendors.map(v => `<option value="${escape(v)}">${escape(v || '(κενό Vendor)')}</option>`).join('');
  $('#vendor').value = state.vendors.includes(vendor) ? vendor : '';
  selected = new Set([...selected].filter(id => state.products.some(p => p.id === id && eligible(p))));
  renderProducts(); renderRules(); renderSettings(); shipping.render(state); refreshCollectionOptions(); ruleExample();
  const labels = { success: 'Επιτυχία', failed: 'Αποτυχία', uncertain: 'Χρειάζεται έλεγχο στο Shopify', pending: 'Σε εξέλιξη' };
  $('#audit-rows').innerHTML = state.audit.length ? state.audit.map(a => `<tr><td>${date(a.created)}</td><td>${a.kind === 'cost' ? 'Κόστος αγοράς' : a.kind === 'shipping' ? 'Μεταφορικά' : 'Τιμή πώλησης'}</td><td>${escape(a.title)}</td><td>${escape(a.sku || '—')}</td><td class="number">${a.old_missing ? '—' : euros(a.old_price)}</td><td class="number">${euros(a.new_price)}</td><td class="${a.status === 'success' ? 'positive' : 'negative'}">${labels[a.status] ?? escape(a.status)}<small>${escape(a.detail)}</small></td></tr>`).join('') : '<tr><td colspan="7" class="empty">Δεν έχουν καταγραφεί αλλαγές τιμών ή κόστους.</td></tr>';
  $('#sync').disabled = state.job.running || state.job.costSaving || state.job.priceSaving;
  $('#job').hidden = !state.job.running && !state.job.message && !state.job.error;
  $('#job').textContent = state.job.running ? `${state.job.type === 'sync' ? 'Συγχρονισμός προϊόντων' : state.job.type === 'shipping-sync' ? 'Συγχρονισμός μεταφορικών' : state.job.type === 'shipping-apply' ? 'Ενημέρωση μεταφορικών' : 'Ενημέρωση τιμών'}: ${state.job.completed}${state.job.total ? ' / ' + state.job.total : ''}…` : state.job.error || state.job.message;
  if (wasRunning && !state.job.running) notify(state.job.error || state.job.message, Boolean(state.job.error));
  if (state.job.running) timer = setTimeout(() => load().catch(e => notify(e.message, true)), 2000);
}

$('#login-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => { await api('login', { password: new FormData(event.target).get('password') }); event.target.reset(); await load(); });
});
$('#logout').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('logout', {}); clearTimeout(timer); state = null; selected.clear(); shipping.reset(); $('#workspace').hidden = true; $('#login').hidden = false;
}));
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
for (const selector of ['#search', '#vendor', '#filter', '#status-filter', '#price-filter', '#cost-filter']) $(selector).addEventListener(selector === '#search' ? 'input' : 'change', () => { page = 0; renderProducts(); });
$('#previous').addEventListener('click', () => { page--; renderProducts(); });
$('#next').addEventListener('click', () => { page++; renderProducts(); });
$('#product-rows').addEventListener('change', event => {
  const id = event.target.dataset.select; if (!id) return;
  if (event.target.checked && selected.size >= 2000) { event.target.checked = false; return notify('Μέχρι 2.000 παραλλαγές ανά εφαρμογή.', true); }
  event.target.checked ? selected.add(id) : selected.delete(id); renderProducts();
});
$('#product-rows').addEventListener('click', event => {
  const imageButton = event.target.closest('[data-image]');
  if (imageButton) {
    const product = state.products.find(p => p.id === imageButton.dataset.image);
    $('#image-title').textContent = product.title;
    $('#product-image').alt = product.image.altText || product.title;
    $('#product-image').src = product.image.url;
    $('#image-dialog').showModal(); return;
  }
  const priceButton = event.target.closest('[data-price]');
  if (priceButton) {
    const product = state.products.find(p => p.id === priceButton.dataset.price);
    priceEdit = { id: product.id, expectedPrice: product.price };
    $('#price-product').textContent = `${product.title} / ${product.variant} · ${product.vendor} · SKU: ${product.sku || '—'}`;
    $('#price-form').elements.price.value = (product.price / 100).toFixed(2);
    $('#price-dialog').showModal(); $('#price-form').elements.price.focus(); return;
  }
  const button = event.target.closest('[data-cost]'); if (!button) return;
  const product = state.products.find(p => p.id === button.dataset.cost);
  costEdit = { id: product.id, expectedCost: product.cost };
  $('#cost-product').textContent = `${product.title} / ${product.variant} · ${product.vendor} · SKU: ${product.sku || '—'}`;
  $('#cost-form').elements.cost.value = product.cost === null ? '' : (product.cost / 100).toFixed(2);
  $('#cost-dialog').showModal(); $('#cost-form').elements.cost.focus();
});
$('#close-image').addEventListener('click', () => $('#image-dialog').close());
$('#image-dialog').addEventListener('click', event => { if (event.target === $('#image-dialog')) $('#image-dialog').close(); });
$('#image-dialog').addEventListener('close', () => { $('#product-image').removeAttribute('src'); });
$('#close-price').addEventListener('click', () => { if (!pricePending) $('#price-dialog').close(); });
$('#price-dialog').addEventListener('cancel', event => { if (pricePending) event.preventDefault(); });
$('#price-form').addEventListener('submit', event => {
  event.preventDefault(); if (!priceEdit || pricePending) return;
  action(event.submitter, async () => {
    pricePending = true; $('#close-price').disabled = true;
    try {
      await api('price', { ...priceEdit, price: event.target.elements.price.value });
      priceEdit = null; $('#price-dialog').close(); await load();
      notify('Η τελική τιμή πώλησης αποθηκεύτηκε στο Shopify.');
    } finally { pricePending = false; $('#close-price').disabled = false; }
  });
});
$('#close-cost').addEventListener('click', () => { if (!costPending) $('#cost-dialog').close(); });
$('#cost-dialog').addEventListener('cancel', event => { if (costPending) event.preventDefault(); });
$('#cost-form').addEventListener('submit', event => {
  event.preventDefault(); if (!costEdit || costPending) return;
  action(event.submitter, async () => {
    costPending = true; $('#close-cost').disabled = true;
    try {
      await api('cost', { ...costEdit, cost: event.target.elements.cost.value });
      costEdit = null; $('#cost-dialog').close(); await load();
      notify('Το κόστος αγοράς αποθηκεύτηκε στο Shopify. Η τιμή πώλησης δεν άλλαξε.');
    } finally { costPending = false; $('#close-cost').disabled = false; }
  });
});
$('#select-page').addEventListener('change', event => {
  const check = event.target.checked;
  for (const p of filtered().slice(page * 50, page * 50 + 50).filter(eligible)) {
    if (!check) selected.delete(p.id); else if (selected.size < 2000) selected.add(p.id);
  }
  renderProducts();
});
$('#select-filtered').addEventListener('click', () => { selected = new Set(filtered().filter(eligible).slice(0, 2000).map(p => p.id)); renderProducts(); });
$('#clear-selection').addEventListener('click', () => { selected.clear(); renderProducts(); });
$('#sync').addEventListener('click', event => action(event.currentTarget, async () => { await api('sync', {}); await load(); }));
$('#preview').addEventListener('click', event => action(event.currentTarget, async () => {
  preview = await api('preview', { ids: [...selected] });
  $('#preview-rows').innerHTML = preview.items.map(p => `<tr><td>${escape(p.title)}</td><td class="number">${euros(p.oldPrice)}</td><td class="number new-price">${euros(p.newPrice)}</td><td class="number">${euros(p.newPrice - p.oldPrice)}</td></tr>`).join('');
  $('#preview-dialog').showModal();
}));
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#apply').addEventListener('click', event => action(event.currentTarget, async () => {
  if (!preview) return; await api('apply', { id: preview.id }); preview = null; $('#preview-dialog').close(); selected.clear(); await load();
}));
const ruleForm = $('#rule-form');
function collectionOptions(selected = '') {
  const collections = state ? state.collections : [];
  return '<option value="">Όλα τα collections</option>' + collections.map(c => `<option value="${escape(c.id)}" ${c.id === selected ? 'selected' : ''}>${escape(c.title)}</option>`).join('')
    + (selected && !collections.some(c => c.id === selected) ? `<option value="${escape(selected)}" selected>Collection δεν βρέθηκε — κάνε συγχρονισμό</option>` : '');
}
function refreshCollectionOptions() {
  for (const select of document.querySelectorAll('[data-condition-field="collectionId"]')) select.innerHTML = collectionOptions(select.value);
  const example = $('#example-collections'), selectedIds = [...example.selectedOptions].map(o => o.value);
  example.innerHTML = state.collections.map(c => `<option value="${escape(c.id)}" ${selectedIds.includes(c.id) ? 'selected' : ''}>${escape(c.title)}</option>`).join('');
}
function conditionInputs() {
  return [...document.querySelectorAll('.condition-row')].map(row => Object.fromEntries([...row.querySelectorAll('[data-condition-field]')].map(field => [field.dataset.conditionField, field.value])));
}
function renumberConditions() {
  document.querySelectorAll('.condition-row legend').forEach((legend, i) => { legend.textContent = `Όρος ${i + 1}`; });
  $('#conditions-empty').hidden = Boolean(document.querySelector('.condition-row'));
}
function addCondition(c = { from: '0', to: '999,99', amount: '0', collectionId: '' }) {
  if (document.querySelectorAll('.condition-row').length >= 50) return notify('Έως 50 όροι ανά brand.', true);
  $('#condition-rows').insertAdjacentHTML('beforeend', `<fieldset class="condition-row"><legend></legend><div class="condition-grid">
    <label>Τιμή από (€)<input data-condition-field="from" inputmode="decimal" value="${escape(c.from)}" required></label>
    <label>Τιμή μέχρι (€)<input data-condition-field="to" inputmode="decimal" value="${escape(c.to)}" required></label>
    <label>Προσθήκη πριν τον ΦΠΑ (€)<input data-condition-field="amount" inputmode="decimal" value="${escape(c.amount)}" required></label>
    <label class="condition-collection">Collection (προαιρετικό)<select data-condition-field="collectionId">${collectionOptions(c.collectionId)}</select></label>
    </div><button type="button" class="quiet" data-remove-condition>Αφαίρεση όρου</button></fieldset>`);
  renumberConditions();
}
function clearConditions() { $('#condition-rows').innerHTML = ''; $('#example-collections').value = ''; renumberConditions(); }
$('#add-condition').addEventListener('click', () => { addCondition(); ruleExample(); });
$('#condition-rows').addEventListener('click', event => {
  if (event.target.closest('[data-remove-condition]')) { event.target.closest('.condition-row').remove(); renumberConditions(); ruleExample(); }
});
function ruleExample() {
  const marginMode = ruleForm.elements.mode.value === 'margin';
  $('#multiplier-fields').hidden = marginMode; $('#margin-fields').hidden = !marginMode;
  ruleForm.elements.multiplier.disabled = marginMode; ruleForm.elements.multiplier.required = !marginMode;
  ruleForm.elements.targetMargin.disabled = !marginMode; ruleForm.elements.targetMargin.required = marginMode;
  $('#rule-formula').textContent = marginMode
    ? '(Αγορά ÷ (1 − μικτό περιθώριο / 100) + σύνολο ποσών όρων) × προαιρετικός ΦΠΑ'
    : '(Αγορά × συντελεστής + σύνολο ποσών όρων) × προαιρετικός ΦΠΑ';
  try {
    const rule = validateRule({ vendor: 'Παράδειγμα', mode: ruleForm.elements.mode.value,
      multiplier: ruleForm.elements.multiplier.value, targetMargin: ruleForm.elements.targetMargin.value,
      conditions: conditionInputs(), addVat: ruleForm.elements.addVat.checked, vat: ruleForm.elements.vat.value });
    const cost = decimal($('#example-cost').value, 'Δοκιμαστική αγορά');
    const result = calculate(cost, rule, true, [...$('#example-collections').selectedOptions].map(o => o.value));
    if (result.error) throw new Error(result.error);
    const format = value => new Intl.NumberFormat('el-GR', { maximumFractionDigits: 4 }).format(value);
    const base = marginMode
      ? `${euros(cost)} ÷ (1 − ${format(rule.targetMargin / 100)} / 100)`
      : `${euros(cost)} × ${format(rule.multiplier / 10000)}`;
    $('#example-reference').textContent = `Τιμή ελέγχου όρων: ${euros(result.referencePrice)} (πριν από τις προσθήκες των όρων)`;
    $('#example-added').textContent = `Συνολικό σταθερό ποσό πριν τον ΦΠΑ: ${euros(result.fixed)}`;
    $('#rule-example').textContent = `(${base} + ${euros(result.fixed)}) × ${format(rule.addVat ? 1 + rule.vat / 10000 : 1)} → ${euros(result.final)} μετά τη στρογγυλοποίηση`;
    $('#example-final').textContent = euros(result.final);
    $('#example-profit').textContent = euros(result.profit);
    $('#example-margin').textContent = pct(result.margin);
    $('#example-note').textContent = marginMode && !rule.addVat && rule.vat > 0
      ? 'Σε φορολογητέα πώληση, χωρίς προσθήκη ΦΠΑ η αφαίρεσή του από την τελική τιμή μειώνει το πραγματικό περιθώριο κάτω από τον στόχο.'
      : 'Παράδειγμα ελληνικής φορολογητέας πώλησης. Το κέρδος και το περιθώριο υπολογίζονται από τη στρογγυλεμένη τιμή και δεν περιλαμβάνουν μεταφορικά και λοιπά έξοδα.';
  } catch (error) {
    $('#example-reference').textContent = ''; $('#example-added').textContent = '';
    $('#rule-example').textContent = error.message;
    for (const id of ['#example-final', '#example-profit', '#example-margin']) $(id).textContent = '—';
    $('#example-note').textContent = '';
  }
}
ruleForm.addEventListener('input', ruleExample);
ruleForm.addEventListener('change', ruleExample);
ruleForm.addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  const data = Object.fromEntries(new FormData(ruleForm)); data.addVat = ruleForm.elements.addVat.checked;
  data.conditions = conditionInputs();
  await api('rules', data); await load(); notify('Ο κανόνας αποθηκεύτηκε. Οι τιμές Shopify δεν άλλαξαν.');
}); });
$('#reset-rule').addEventListener('click', () => { ruleForm.reset(); clearConditions(); ruleExample(); });
$('#rules').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit-rule]'), create = event.target.closest('[data-new-rule]'), remove = event.target.closest('[data-delete-rule]');
  if (edit) {
    const r = state.rules.find(r => r.vendor === edit.dataset.editRule);
    ruleForm.elements.vendor.value = r.vendor;
    clearConditions();
    for (const c of r.conditions) addCondition({ ...c, from: (c.from / 100).toFixed(2), to: (c.to / 100).toFixed(2), amount: (c.amount / 100).toFixed(2) });
    ruleForm.elements.mode.value = r.mode;
    ruleForm.elements.multiplier.value = r.multiplier === null ? '' : String(r.multiplier / 10000);
    ruleForm.elements.targetMargin.value = r.targetMargin === null ? '40' : String(r.targetMargin / 100);
    ruleForm.elements.vat.value = (r.vat / 100).toFixed(2);
    ruleForm.elements.addVat.checked = r.addVat; ruleExample();
  }
  if (create) { ruleForm.reset(); clearConditions(); ruleForm.elements.vendor.value = create.dataset.newRule; ruleForm.elements.multiplier.focus(); ruleExample(); }
  if (remove && confirm('Να διαγραφεί ο κανόνας ' + remove.dataset.deleteRule + '; Οι τιμές Shopify δεν αλλάζουν.')) action(remove, async () => { await api('rules/delete', { vendor: remove.dataset.deleteRule }); await load(); });
});
$('#settings-form').addEventListener('input', () => { settingsDirty = true; authFields(); });
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  await api('settings', Object.fromEntries(new FormData(event.target))); settingsDirty = false;
  event.target.elements.clientSecret.value = ''; event.target.elements.accessToken.value = '';
  $('#connection-result').textContent = ''; await load(); notify('Τα στοιχεία αποθηκεύτηκαν. Κάνε έλεγχο σύνδεσης.');
}); });
$('#test-connection').addEventListener('click', event => action(event.currentTarget, async () => {
  const result = await api('settings/test', {}); $('#connection-result').textContent = `Επιτυχής σύνδεση: ${result.shop.name} · ${result.shop.currencyCode}`;
}));
const shipping = shippingUI({ $, api, action, notify, load, euros, escape, date });
ruleExample();
load().catch(error => { if (state) notify(error.message, true); else { $('#login').hidden = false; if (error.message !== 'Χρειάζεται σύνδεση.') notify(error.message, true); } });
