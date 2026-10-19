export function postalUI({ $, api, action, notify, load, escape, date }) {
  let state, editing = null;
  const countryNames = new Intl.DisplayNames(['el'], { type: 'region' });
  const name = (code, entry) => `${countryNames.of(code) || entry.name} (${code})`;
  function filtered() {
    const search = $('#postal-search').value.toLocaleLowerCase('el'), status = $('#postal-status').value;
    return Object.entries(state?.shipping.directory ?? {}).filter(([code, entry]) =>
      `${name(code, entry)} ${entry.name} ${entry.city} ${entry.postalCode}`.toLocaleLowerCase('el').includes(search) &&
      (!status || (status === 'none' && entry.noPostalCode) || (status === 'ready' && entry.postalCode && !entry.noPostalCode) || (status === 'missing' && !entry.postalCode && !entry.noPostalCode) || (status === 'error' && entry.error)))
      .sort((a,b) => name(...a).localeCompare(name(...b), 'el'));
  }
  function render(next = state) {
    state = next; if (!state) return;
    const entries = filtered(), busy = state.job.running || state.job.priceSaving || state.job.costSaving;
    $('#postal-count').textContent = `${entries.length} χώρες στο φίλτρο · ${Object.keys(state.shipping.directory ?? {}).length} συνολικά`;
    $('#postal-refresh-all').disabled = busy; $('#postal-refresh-filtered').disabled = busy || !entries.length;
    $('#postal-rows').innerHTML = entries.map(([code, e]) => `<tr><td><strong>${escape(name(code,e))}</strong></td><td>${escape(e.city || 'Δεν έχει οριστεί')}</td><td>${e.noPostalCode ? 'Δεν χρησιμοποιείται ΤΚ' : escape(e.postalCode || 'Χρειάζεται συμπλήρωση')}</td><td>${e.source && /^https:\/\//.test(e.source) ? `<a href="${escape(e.source)}" target="_blank" rel="noopener noreferrer">Πηγή</a>` : e.manual ? 'Χειροκίνητη εγγραφή' : '—'}<small>Ενημέρωση: ${date(e.updatedAt)}${e.attemptedAt ? '<br>Τελευταίος έλεγχος: '+date(e.attemptedAt) : ''}</small>${e.error ? `<small class="negative">${escape(e.error)}</small>` : ''}</td><td><div class="actions"><button class="quiet" data-postal-edit="${code}" ${busy?'disabled':''}>Επεξεργασία</button><button class="quiet" data-postal-refresh="${code}" ${busy?'disabled':''}>Ενημέρωση</button></div></td></tr>`).join('') || '<tr><td colspan="5">Δεν βρέθηκαν χώρες.</td></tr>';
    $('#postal-form').querySelector('button').disabled = busy;
  }
  for (const button of document.querySelectorAll('[data-settings-tab]')) button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('[data-settings-tab]')) {
      const active = b === button; b.classList.toggle('active', active); b.classList.toggle('quiet', !active); $('#'+b.dataset.settingsTab).hidden = !active;
    }
  });
  $('#postal-search').addEventListener('input', () => render()); $('#postal-status').addEventListener('change', () => render());
  async function refresh(button, codes) { await action(button, async () => { await api('shipping/countries/refresh', codes ? { codes } : {}); await load(); notify('Ξεκίνησε η ενημέρωση χωρών & ΤΚ από το internet.'); }); render(); }
  $('#postal-refresh-all').addEventListener('click', e => refresh(e.currentTarget));
  $('#postal-refresh-filtered').addEventListener('click', e => refresh(e.currentTarget, filtered().map(([code])=>code)));
  $('#postal-rows').addEventListener('click', e => {
    const edit = e.target.closest('[data-postal-edit]'), update = e.target.closest('[data-postal-refresh]');
    if (update) refresh(update, [update.dataset.postalRefresh]);
    if (edit) {
      editing = edit.dataset.postalEdit; const entry = state.shipping.directory[editing], form = $('#postal-form');
      $('#postal-country').textContent = name(editing, entry); form.elements.city.value = entry.city; form.elements.postalCode.value = entry.postalCode;
      form.elements.noPostalCode.checked = entry.noPostalCode; togglePostal(); $('#postal-dialog').showModal();
    }
  });
  function togglePostal() { const f = $('#postal-form'); f.elements.postalCode.required = !f.elements.noPostalCode.checked; f.elements.postalCode.disabled = f.elements.noPostalCode.checked; }
  $('#postal-form').elements.noPostalCode.addEventListener('change', togglePostal);
  $('#postal-close').addEventListener('click', () => $('#postal-dialog').close());
  $('#postal-form').addEventListener('submit', e => { e.preventDefault(); action(e.submitter, async () => {
    const f = e.target; await api('shipping/countries/save', { code: editing, city: f.elements.city.value, postalCode: f.elements.postalCode.value, noPostalCode: f.elements.noPostalCode.checked });
    $('#postal-dialog').close(); await load(); notify('Τα στοιχεία της χώρας αποθηκεύτηκαν.');
  }); });
  return { render };
}
