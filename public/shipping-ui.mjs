import { sampleDefaults } from './shipping-sample.mjs';
export function shippingUI({ $, api, action, notify, load, euros, escape, date }) {
  let state, selected = new Set(), page = 0, sampleId = null, previewId = null, dhlDirty = false;
  const percent = n => new Intl.NumberFormat('el-GR', { maximumFractionDigits: 2 }).format(n);
  function filtered() {
    const profile = $('#shipping-profile').value, zone = $('#shipping-zone').value, search = $('#shipping-search').value.toLocaleLowerCase('el');
    return (state?.shipping.rows ?? []).filter(r => (!profile || r.profileId === profile) && (!zone || r.zoneId === zone) && `${r.name} ${r.zoneName} ${r.countries.map(c=>c.name).join(' ')}`.toLocaleLowerCase('el').includes(search));
  }
  const eligible = r => r.editable && (r.price !== 0 || $('#shipping-include-free').checked);
  function proposal(row) {
    let base = row.price;
    if ($('#shipping-base').value === 'dhl') {
      if (!row.quote || Date.now() - Date.parse(row.quote.at) > 900000 || row.quote.environment !== 'live') return null;
      base = row.quote.products.find(p => p.code === $('#shipping-service').value)?.price;
    }
    const input = $('#shipping-value').value.trim().replace(',', '.');
    if (base == null || !/^[+-]?\d+(?:\.\d{1,2})?$/.test(input)) return null;
    const value = Number(input), final = $('#shipping-kind').value === 'percent' ? Math.round(base * (1+value/100)) : base + Math.round(value*100);
    return Number.isSafeInteger(final) && final >= 0 && final <= 100000000 ? final : null;
  }
  function conditions(row) {
    if (!row.conditions.length) return 'Χωρίς όρια';
    return row.conditions.map(c => {
      const value = c.conditionCriteria;
      const amount = value.amount !== undefined ? `${value.amount} ${value.currencyCode}` : `${percent(value.value)} ${value.unit}`;
      return `${c.field === 'TOTAL_WEIGHT' ? 'Βάρος' : 'Παραγγελία'} ${c.operator === 'GREATER_THAN_OR_EQUAL_TO' ? '≥' : '≤'} ${amount}`;
    }).join(' · ');
  }
  function renderRows() {
    if (!state) return;
    const all = filtered(), pages = Math.max(1, Math.ceil(all.length/50)); page = Math.min(page,pages-1);
    const busy = state.job.running || state.job.priceSaving || state.job.costSaving;
    $('#shipping-rows').innerHTML = all.slice(page*50,page*50+50).map(r => {
      const q = r.quote, service = q?.products.find(p => p.code === $('#shipping-service').value), fresh = q && Date.now()-Date.parse(q.at) <=900000;
      const proposed = r.editable ? proposal(r) : null, direction = proposed !== null && proposed !== r.price ? (proposed > r.price ? 'up' : 'down') : '';
      const s = r.sample;
      return `<tr><td><input type="checkbox" data-shipping-select="${escape(r.id)}" aria-label="Επιλογή ${escape(r.zoneName)} ${escape(r.name)}" ${selected.has(r.id)?'checked':''} ${!eligible(r)||busy?'disabled':''}></td>
        <td><strong>${escape(r.zoneName)}</strong><small>${escape(r.profileName)}<br>${escape(r.countries.map(c=>c.name).join(', '))}</small></td>
        <td><strong>${escape(r.name)}</strong><small>${escape(conditions(r))}<br>${r.active?'Ενεργή':'Ανενεργή'}${r.editable?'': ' · Μόνο ανάγνωση ('+escape(r.currency||'carrier')+')'}</small></td>
        <td class="number">${r.currency==='EUR'?euros(r.price): r.price===null?'Αυτόματη χρέωση':escape((r.price/100).toFixed(2)+' '+r.currency)}</td>
        <td class="number">${fresh && service?euros(service.price):'—'}${q?`<small>${q.environment==='test'?'TEST · ':''}${escape(service?.name || 'Επίλεξε υπηρεσία')}<br>${date(q.at)}${!fresh?' · Έληξε':''}${service?.weight?.volumetric != null?'<br>Ογκομετρικό: '+escape(service.weight.volumetric)+' kg':''}</small>`:''}</td>
        <td class="number ${direction?'price-'+direction:''}">${direction?(direction==='up'?'↑ ':'↓ '):''}${proposed===null?'—':euros(proposed)}</td>
        <td><small>${s?escape(`${s.destinationCountryCode} ${s.destinationPostalCode} · ${s.destinationCityName} · ${s.weight} kg · ${s.length}×${s.width}×${s.height} cm · ${s.plannedShippingDate}`):'Δεν έχει οριστεί δείγμα'}</small><div class="actions"><button class="quiet" data-shipment="${escape(r.id)}" ${busy?'disabled':''}>${s?'Δείγμα':'Ορισμός δείγματος'}</button><button class="quiet" data-quote="${escape(r.id)}" ${!s||busy?'disabled':''}>Λήψη DHL</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Δεν υπάρχουν κλίμακες. Κάνε συγχρονισμό μεταφορικών ή άλλαξε φίλτρα.</td></tr>';
    $('#shipping-selection-count').textContent = `${selected.size} επιλεγμένες · ${all.length} στο φίλτρο`;
    $('#shipping-page').textContent = `${page+1} / ${pages}`;
    $('#shipping-previous').disabled = page===0; $('#shipping-next').disabled = page>=pages-1;
    $('#shipping-preview').disabled = !selected.size || busy; $('#shipping-quotes').disabled = !selected.size || busy;
    $('#shipping-sync').disabled = busy; $('#shipping-autofill-selected').disabled = !selected.size || busy;
  }
  function options(selector, values, label) {
    const old = $(selector).value;
    $(selector).innerHTML = `<option value="">${label}</option>`+[...values].map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('');
    if (values.has(old)) $(selector).value=old;
  }
  function render(next) {
    state = next;
    const rows = state.shipping.rows;
    selected = new Set([...selected].filter(id=>rows.some(r=>r.id===id&&eligible(r))));
    options('#shipping-profile',new Map(rows.map(r=>[r.profileId,r.profileName])),'Όλα');
    options('#shipping-zone',new Map(rows.filter(r=>!$('#shipping-profile').value||r.profileId===$('#shipping-profile').value).map(r=>[r.zoneId,r.zoneName])),'Όλες');
    const services = new Map(rows.flatMap(r=>(r.quote?.products??[]).map(p=>[p.code,`${p.code} · ${p.name}`])));
    options('#shipping-service',services,'Επίλεξε υπηρεσία DHL');
    $('#shipping-sync-time').textContent = state.shipping.lastSync?'Τελευταίος συγχρονισμός: '+date(state.shipping.lastSync):'Δεν έχει γίνει συγχρονισμός μεταφορικών.';
    const d=state.shipping.dhl;
    if (!dhlDirty && d) for(const [k,v] of Object.entries(d)) if($('#dhl-form').elements[k]) $('#dhl-form').elements[k].value=v;
    $('#dhl-state').textContent = d?`Αποθηκευμένος κωδικός: ${d.hasPassword?'ναι':'όχι'}. Κενό password διατηρεί τον υπάρχοντα.`:'Δεν έχει ρυθμιστεί η σύνδεση DHL.';
    renderRows();
  }
  $('#dhl-form').addEventListener('input',()=>{dhlDirty=true;});
  $('#dhl-form').addEventListener('submit',event=>{event.preventDefault();action(event.submitter,async()=>{
    await api('dhl/settings',Object.fromEntries(new FormData(event.target)));event.target.elements.password.value='';dhlDirty=false;await load();notify('Η σύνδεση DHL αποθηκεύτηκε. Δοκίμασε προσφορά από τα Μεταφορικά.');
  });});
  $('#shipping-sync').addEventListener('click',e=>action(e.currentTarget,async()=>{await api('shipping/sync',{});await load();}));
  for(const id of ['shipping-profile','shipping-zone','shipping-search','shipping-include-free']) $('#'+id).addEventListener(id==='shipping-search'?'input':'change',()=>{
    page=0;if(id==='shipping-profile') options('#shipping-zone',new Map(state.shipping.rows.filter(r=>!$('#shipping-profile').value||r.profileId===$('#shipping-profile').value).map(r=>[r.zoneId,r.zoneName])),'Όλες');
    selected=new Set([...selected].filter(id=>state.shipping.rows.some(r=>r.id===id&&eligible(r))));renderRows();
  });
  for(const id of ['shipping-base','shipping-service','shipping-kind','shipping-value']) $('#'+id).addEventListener(id==='shipping-value'?'input':'change',renderRows);
  $('#shipping-select').addEventListener('click',()=>{for(const r of filtered().filter(eligible)){if(selected.size>=2000)break;selected.add(r.id);}renderRows();});
  $('#shipping-clear').addEventListener('click',()=>{selected.clear();renderRows();});
  $('#shipping-previous').addEventListener('click',()=>{page--;renderRows();});$('#shipping-next').addEventListener('click',()=>{page++;renderRows();});
  $('#shipping-rows').addEventListener('change',e=>{const id=e.target.dataset.shippingSelect;if(!id)return;if(e.target.checked&&selected.size>=2000){e.target.checked=false;notify('Μέχρι 2.000 κλίμακες.',true);return;}e.target.checked?selected.add(id):selected.delete(id);renderRows();});
  $('#shipping-rows').addEventListener('click',e=>{
    const sample=e.target.closest('[data-shipment]'),quote=e.target.closest('[data-quote]');
    if(sample){const r=state.shipping.rows.find(r=>r.id===sample.dataset.shipment);sampleId=r.id;$('#shipment-autofill-note').textContent='';const form=$('#shipment-form');form.reset();
      $('#shipment-row-label').textContent=`${r.profileName} / ${r.zoneName} / ${r.name} · ${conditions(r)}`;
      form.elements.plannedShippingDate.value=new Date().toISOString().slice(0,10);
      if(r.countries.length===1)form.elements.destinationCountryCode.value=r.countries[0].code.countryCode||'';
      if(r.sample)for(const[k,v]of Object.entries(r.sample)){
        // namedItem avoids the native collection.length property masking the parcel length input.
        const field=form.elements.namedItem(k);
        if(k==='isCustomsDeclarable')field.checked=v;else field.value=v;
      }
      $('#shipment-dialog').showModal();
    }
    if(quote)action(quote,async()=>{await api('shipping/quote',{id:quote.dataset.quote});await load();notify('Η DHL επέστρεψε προσφορές. Επίλεξε υπηρεσία για σύγκριση.');});
  });
  $('#shipment-autofill').addEventListener('click', () => {
    const row = state.shipping.rows.find(r => r.id === sampleId);
    try {
      const values = sampleDefaults(row, new Date().toISOString().slice(0,10));
      const form = $('#shipment-form');
      for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value;
      const missing = [];
      if (!values.destinationCountryCode) missing.push('Η ζώνη δεν ορίζει συγκεκριμένη χώρα: επίλεξε χώρα και πόλη.');
      else if (!values.destinationCityName) missing.push('Συμπλήρωσε πόλη για τη συγκεκριμένη χώρα.');
      if (values.destinationCountryCode && !values.destinationPostalCode) missing.push('Δεν υπάρχει επιβεβαιωμένος ΤΚ για αυτή την πόλη. Συμπλήρωσέ τον.');
      if (!values.weight) missing.push('Η κλίμακα δεν έχει χρησιμοποιήσιμο μέγιστο βάρος: συμπλήρωσε κιλά.');
      $('#shipment-autofill-note').textContent = missing.join(' ');
    } catch (error) { notify(error.message, true); }
  });
  $('#shipment-close').addEventListener('click',()=>$('#shipment-dialog').close());
  $('#shipment-form').addEventListener('submit',e=>{e.preventDefault();action(e.submitter,async()=>{
    const sample=Object.fromEntries(new FormData(e.target));sample.isCustomsDeclarable=e.target.elements.isCustomsDeclarable.checked;
    await api('shipping/sample',{id:sampleId,sample});$('#shipment-dialog').close();await load();notify('Το δείγμα αποθηκεύτηκε.');
  });});
  $('#shipping-autofill-selected').addEventListener('click', e => action(e.currentTarget, async () => {
    const result = await api('shipping/samples/autofill', { ids: [...selected] });
    await load();
    const message = `${result.saved.length} δείγματα αποθηκεύτηκαν · ${result.skipped.length} παραλείφθηκαν.`;
    $('#shipping-autofill-result').hidden = false;
    $('#shipping-autofill-result').innerHTML = `<p>${escape(message)}</p>` + (result.skipped.length ? `<details><summary>Δες ποιες κλίμακες χρειάζονται χειροκίνητη συμπλήρωση</summary><ul>${result.skipped.map(item => `<li>${escape(item.title)}: ${escape(item.error)}</li>`).join('')}</ul></details>` : '');
    notify(message, Boolean(result.skipped.length));
  }));
  $('#shipping-quotes').addEventListener('click',e=>action(e.currentTarget,async()=>{
    const ids=[...selected];let done=0,failed=0;let lastError='';
    for(const id of ids){try{await api('shipping/quote',{id});done++;}catch(e){failed++;lastError=e.message;}$('#shipping-selection-count').textContent=`DHL: ${done+failed} / ${ids.length} · ${failed} αποτυχίες`;}
    await load();notify(`DHL: ${done} προσφορές, ${failed} αποτυχίες.${lastError?' '+lastError:''}`,Boolean(failed));
  }));
  $('#shipping-preview').addEventListener('click',e=>action(e.currentTarget,async()=>{
    const plan=await api('shipping/preview',{ids:[...selected],base:$('#shipping-base').value,serviceCode:$('#shipping-service').value,kind:$('#shipping-kind').value,value:$('#shipping-value').value,includeFree:$('#shipping-include-free').checked});
    previewId=plan.id;$('#shipping-preview-rows').innerHTML=plan.items.map(i=>`<tr><td>${escape(i.title)}</td><td>${euros(i.oldPrice)}</td><td class="${i.newPrice>i.oldPrice?'price-up':'price-down'}">${euros(i.newPrice)}</td><td>${euros(i.newPrice-i.oldPrice)}</td></tr>`).join('');$('#shipping-preview-dialog').showModal();
  }));
  $('#shipping-preview-close').addEventListener('click',()=>$('#shipping-preview-dialog').close());
  $('#shipping-apply').addEventListener('click',e=>action(e.currentTarget,async()=>{await api('shipping/apply',{id:previewId});previewId=null;$('#shipping-preview-dialog').close();selected.clear();await load();}));
  return { render, reset(){selected.clear();state=null;dhlDirty=false;$('#shipping-autofill-result').hidden=true;$('#shipping-autofill-result').textContent='';$('#dhl-form').reset();} };
}
