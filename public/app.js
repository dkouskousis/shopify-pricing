const $ = selector => document.querySelector(selector);
const euros = cents => cents === null || cents === undefined ? '—' : new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const pct = number => new Intl.NumberFormat('el-GR', { maximumFractionDigits: 2 }).format(number) + '%';
const date = value => value ? new Date(value).toLocaleString('el-GR') : '—';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null, selected = new Set(), page = 0, preview = null, timer = null, settingsDirty = false;
let notificationTimer;
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
  const query = $('#search').value.trim().toLocaleLowerCase(), vendor = $('#vendor').value, filter = $('#filter').value;
  return state.products.filter(p => (!vendor || p.vendor === vendor)
    && (!query || `${p.title} ${p.variant} ${p.sku}`.toLocaleLowerCase().includes(query))
    && (filter === 'all' || (filter === 'missing' ? p.result.error : !p.result.error && p.result.final !== p.price)));
}
function eligible(p) { return !p.result.error && p.result.final !== p.price; }
function updateSelection() {
  $('#selection-count').textContent = `${selected.size} επιλεγμένες`;
  $('#preview').disabled = !selected.size || Boolean(state?.job.running);
}
function renderProducts() {
  const all = filtered(), pageCount = Math.max(1, Math.ceil(all.length / 50));
  page = Math.min(page, pageCount - 1);
  const visible = all.slice(page * 50, page * 50 + 50);
  $('#product-rows').innerHTML = visible.length ? visible.map(p => `<tr>
    <td><input type="checkbox" data-select="${escape(p.id)}" aria-label="Επιλογή ${escape(p.title)} ${escape(p.variant)}" ${selected.has(p.id) ? 'checked' : ''} ${eligible(p) ? '' : 'disabled'}></td>
    <td><span class="product-title">${escape(p.title)}</span><small>${escape(p.variant)} · ${escape(p.vendor)}<br>SKU: ${escape(p.sku || '—')} · ${escape(p.status)}</small>${p.result.error ? `<small class="negative">${escape(p.result.error)}</small>` : ''}</td>
    <td class="number">${euros(p.cost)}</td><td><button class="quiet extra-button" data-extra="${escape(p.id)}">${euros(p.extra)}</button></td>
    <td class="number">${euros(p.price)}${p.compareAt ? `<small>Compare-at: ${euros(p.compareAt)}</small>` : ''}</td>
    <td class="number new-price">${p.result.error ? '—' : euros(p.result.final)}</td>
    <td class="number ${p.result.profit < 0 ? 'negative' : ''}">${p.result.error ? '—' : euros(p.result.profit)}</td>
    <td class="number ${p.result.margin < 0 ? 'negative' : ''}">${p.result.error ? '—' : pct(p.result.margin)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">Δεν υπάρχουν προϊόντα. Κάνε συγχρονισμό ή άλλαξε τα φίλτρα.</td></tr>';
  $('#page-label').textContent = `Σελίδα ${page + 1} / ${pageCount} · ${all.length} παραλλαγές`;
  $('#previous').disabled = page === 0; $('#next').disabled = page >= pageCount - 1;
  const selectable = visible.filter(eligible);
  $('#select-page').checked = selectable.length > 0 && selectable.every(p => selected.has(p.id));
  $('#select-page').indeterminate = selectable.some(p => selected.has(p.id)) && !$('#select-page').checked;
  updateSelection();
}
function renderRules() {
  $('#vendors-list').innerHTML = state.vendors.map(v => `<option value="${escape(v)}"></option>`).join('');
  $('#rule-list').innerHTML = state.rules.length ? state.rules.map(r => `<div class="rule-card"><div><strong>${escape(r.vendor)}</strong><p>Αγορά +${pct(r.markup / 100)} · +${euros(r.fixed)} · ${r.addVat ? 'με προσθήκη ΦΠΑ ' + pct(r.vat / 100) : 'χωρίς προσθήκη ΦΠΑ'}</p></div><div class="actions"><button class="quiet" data-edit-rule="${escape(r.vendor)}">Επεξεργασία</button><button class="quiet" data-delete-rule="${escape(r.vendor)}" aria-label="Διαγραφή κανόνα ${escape(r.vendor)}">×</button></div></div>`).join('') : '<p class="muted">Δεν έχουν οριστεί κανόνες.</p>';
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
  renderProducts(); renderRules(); renderSettings();
  const labels = { success: 'Επιτυχία', failed: 'Αποτυχία', uncertain: 'Χρειάζεται έλεγχο στο Shopify', pending: 'Σε εξέλιξη' };
  $('#audit-rows').innerHTML = state.audit.length ? state.audit.map(a => `<tr><td>${date(a.created)}</td><td>${escape(a.title)}</td><td class="number">${euros(a.old_price)}</td><td class="number">${euros(a.new_price)}</td><td class="${a.status === 'success' ? 'positive' : 'negative'}">${labels[a.status] ?? escape(a.status)}<small>${escape(a.detail)}</small></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Δεν έχουν εφαρμοστεί αλλαγές τιμών.</td></tr>';
  $('#sync').disabled = state.job.running;
  $('#job').hidden = !state.job.running && !state.job.message && !state.job.error;
  $('#job').textContent = state.job.running ? `${state.job.type === 'sync' ? 'Συγχρονισμός' : 'Ενημέρωση τιμών'}: ${state.job.completed}${state.job.total ? ' / ' + state.job.total : ''}…` : state.job.error || state.job.message;
  if (wasRunning && !state.job.running) notify(state.job.error || state.job.message, Boolean(state.job.error));
  if (state.job.running) timer = setTimeout(() => load().catch(e => notify(e.message, true)), 2000);
}

$('#login-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => { await api('login', { password: new FormData(event.target).get('password') }); event.target.reset(); await load(); });
});
$('#logout').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('logout', {}); clearTimeout(timer); state = null; selected.clear(); $('#workspace').hidden = true; $('#login').hidden = false;
}));
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
for (const selector of ['#search', '#vendor', '#filter']) $(selector).addEventListener(selector === '#search' ? 'input' : 'change', () => { page = 0; renderProducts(); });
$('#previous').addEventListener('click', () => { page--; renderProducts(); });
$('#next').addEventListener('click', () => { page++; renderProducts(); });
$('#product-rows').addEventListener('change', event => {
  const id = event.target.dataset.select; if (!id) return;
  if (event.target.checked && selected.size >= 100) { event.target.checked = false; return notify('Μέχρι 100 παραλλαγές ανά εφαρμογή.', true); }
  event.target.checked ? selected.add(id) : selected.delete(id); renderProducts();
});
$('#product-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-extra]'); if (!button) return;
  const product = state.products.find(p => p.id === button.dataset.extra);
  const amount = prompt(`Πρόσθετη καθαρή χρέωση για ${product.title} / ${product.variant}, π.χ. ογκώδες. Προστίθεται μετά την προσαύξηση και πριν από τον προαιρετικό ΦΠΑ. Καταγράφεται επίσης ως κόστος στην εκτίμηση κέρδους.`, (product.extra / 100).toFixed(2));
  if (amount !== null) action(button, async () => { await api('extra', { id: product.id, amount }); await load(); });
});
$('#select-page').addEventListener('change', event => {
  const check = event.target.checked;
  for (const p of filtered().slice(page * 50, page * 50 + 50).filter(eligible)) {
    if (check && selected.size < 100) selected.add(p.id); else if (!check) selected.delete(p.id);
  }
  renderProducts();
});
$('#select-filtered').addEventListener('click', () => { selected = new Set(filtered().filter(eligible).slice(0, 100).map(p => p.id)); renderProducts(); });
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
function ruleExample() {
  const number = name => Number(ruleForm.elements[name].value.replace(',', '.'));
  const values = ['markup', 'fixed', 'vat'].map(number);
  $('#rule-example').textContent = values.every(Number.isFinite) ? 'Παράδειγμα για αγορά 60€: ' + euros(Math.round((60 * (1 + values[0] / 100) + values[1]) * (ruleForm.elements.addVat.checked ? 1 + values[2] / 100 : 1) * 100)) : '';
}
ruleForm.addEventListener('input', ruleExample);
ruleForm.addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  const data = Object.fromEntries(new FormData(ruleForm)); data.addVat = ruleForm.elements.addVat.checked;
  await api('rules', data); await load(); notify('Ο κανόνας αποθηκεύτηκε. Οι τιμές Shopify δεν άλλαξαν.');
}); });
$('#reset-rule').addEventListener('click', () => { ruleForm.reset(); ruleExample(); });
$('#rules').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit-rule]'), create = event.target.closest('[data-new-rule]'), remove = event.target.closest('[data-delete-rule]');
  if (edit) {
    const r = state.rules.find(r => r.vendor === edit.dataset.editRule);
    ruleForm.elements.vendor.value = r.vendor;
    for (const field of ['markup', 'fixed', 'vat']) ruleForm.elements[field].value = (r[field] / 100).toFixed(2);
    ruleForm.elements.addVat.checked = r.addVat; ruleExample();
  }
  if (create) { ruleForm.reset(); ruleForm.elements.vendor.value = create.dataset.newRule; ruleForm.elements.markup.focus(); ruleExample(); }
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
ruleExample();
load().catch(error => { if (state) notify(error.message, true); else { $('#login').hidden = false; if (error.message !== 'Χρειάζεται σύνδεση.') notify(error.message, true); } });
