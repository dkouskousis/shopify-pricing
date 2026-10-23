import {cleanNumber} from './numeric.mjs';
import { rateGroups, weightLimit, checkRate, destinationRates } from './shipping-summary.mjs';
export function shippingTableUI({ $, escape, euros, date }) {
  let state;
  const format=n=>new Intl.NumberFormat('el-GR',{maximumFractionDigits:3}).format(n);
  const price=r=>r.price===null?'Αυτόματη χρέωση':r.currency==='EUR'?euros(r.price):`${format(r.price/100)} ${escape(r.currency)}`;
  function conditions(row) {
    return row.conditions.map(c=>{
      const kg=weightLimit(c),money=c.field==='TOTAL_PRICE';
      const amount=kg!==null?`${format(kg)} kg`:money?`${escape(c.conditionCriteria.amount)} ${escape(c.conditionCriteria.currencyCode)}`:'Μη υποστηριζόμενος όρος';
      return `${money?'Παραγγελία ':''}${c.operator==='GREATER_THAN_OR_EQUAL_TO'?'≥':'≤'} ${amount}`;
    }).join(' · ')||'Χωρίς όρια';
  }
  function visibleGroups() {
    const query=$('#shipping-summary-search').value.trim().toLocaleLowerCase('el'),profile=$('#shipping-summary-profile').value;
    return rateGroups(state?.shipping.rows??[]).filter(({row,rates})=>(!profile||row.profileId===profile)&&`${row.zoneName} ${row.name} ${row.profileName} ${rates.flatMap(r=>r.countries.map(c=>c.name)).join(' ')}`.toLocaleLowerCase('el').includes(query));
  }
  function renderTable() {
    const groups=visibleGroups(),weights=new Set();
    for(const {rates} of groups)for(const r of rates)for(const c of r.conditions){const w=weightLimit(c);if(w>0&&c.operator==='LESS_THAN_OR_EQUAL_TO')weights.add(w);}
    const sorted=[...weights].sort((a,b)=>a-b);
    $('#shipping-summary-count').textContent=`${groups.length} υπηρεσίες · ${groups.reduce((n,g)=>n+g.rates.length,0)} χρεώσεις`;
    $('#shipping-summary-grid').innerHTML=groups.length?`<table class="shipping-summary-table"><thead><tr><th>Ζώνη / υπηρεσία</th>${sorted.map(w=>`<th>${format(w)} kg</th>`).join('')}${!sorted.length?'<th>Χρεώσεις</th>':''}</tr></thead><tbody>${groups.map(({row,rates})=>`<tr><th><strong>${escape(row.zoneName)}</strong><span>${escape(row.name)}</span><small>${escape(row.profileName)}${row.active?'':' · Ανενεργή'}</small><details><summary>Όλες οι κλίμακες (${rates.length})</summary>${rates.map(r=>`<p>${escape(conditions(r))}<br><strong>${price(r)}</strong>${r.type==='FreeCondition'?' · Δωρεάν αποστολή':''}</p>`).join('')}</details></th>${(sorted.length?sorted:[null]).map(w=>{
      const matches=w===null?rates:rates.filter(r=>checkRate(r,w)!=='excluded');
      return `<td>${matches.length?matches.map(r=>`<div class="shipping-summary-amount">${price(r)}${(w===null||checkRate(r,w)==='conditional')?`<small>${escape(conditions(r))}</small>`:''}</div>`).join(''):'<span class="muted">—</span>'}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`:'<p class="muted">Δεν βρέθηκαν χρεώσεις. Κάνε συγχρονισμό μεταφορικών ή άλλαξε τα φίλτρα.</p>';
  }
  function calculate() {
    const country=$('#shipping-calc-country').value,weight=Number(cleanNumber($('#shipping-calc-weight').value)),text=cleanNumber($('#shipping-calc-value').value);
    const value=text===''?null:Number(text),target=$('#shipping-calc-results');
    if(!country){target.innerHTML='<p class="muted">Επίλεξε χώρα και βάρος για να δεις τις χρεώσεις.</p>';return;}
    if(!Number.isFinite(weight)||weight<=0||value!==null&&(!Number.isFinite(value)||value<0)){target.innerHTML='<p class="negative">Βάλε βάρος μεγαλύτερο από 0 και έγκυρη αξία παραγγελίας.</p>';return;}
    const results=destinationRates(state?.shipping.rows??[],country,weight,value);
    target.innerHTML=results.length?`<div class="shipping-calc-cards">${results.map(({row,status})=>`<article class="shipping-calc-card"><div><strong>${escape(row.name)}</strong><small>${escape(row.zoneName)} · ${escape(row.profileName)}</small></div><strong class="shipping-calc-price">${price(row)}</strong><p>${escape(conditions(row))}</p>${status==='conditional'?`<small class="negative">${value===null?'Υπό προϋποθέσεις · συμπλήρωσε την αξία παραγγελίας για έλεγχο.':'Χρειάζεται έλεγχος πρόσθετων όρων ή νομίσματος στο Shopify.'}</small>`:''}${row.price===null?'<small>Η τελική χρέωση υπολογίζεται στο checkout.</small>':''}</article>`).join('')}</div>`:'<p class="muted">Δεν υπάρχει διαθέσιμη χρέωση για αυτή τη χώρα και το βάρος στα συγχρονισμένα προφίλ.</p>';
  }
  function render(next) {
    state=next;
    const profiles=new Map(state.shipping.rows.map(r=>[r.profileId,r.profileName])),selected=$('#shipping-summary-profile').value;
    $('#shipping-summary-profile').innerHTML='<option value="">Όλα τα προφίλ</option>'+[...profiles].map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('');
    if(profiles.has(selected))$('#shipping-summary-profile').value=selected;
    const countries=new Map(Object.entries(state.shipping.directory??{}).map(([code,c])=>[code,c.name]));
    for(const r of state.shipping.rows)for(const c of r.countries)if(!c.code.restOfWorld)countries.set(c.code.countryCode,c.name);
    const country=$('#shipping-calc-country').value;
    $('#shipping-calc-country').innerHTML='<option value="">Επίλεξε χώρα</option>'+[...countries].sort((a,b)=>a[1].localeCompare(b[1])).map(([code,name])=>`<option value="${escape(code)}">${escape(name)}</option>`).join('');
    if(countries.has(country))$('#shipping-calc-country').value=country;
    $('#shipping-summary-sync').textContent=state.shipping.lastSync?'Στοιχεία Shopify · '+date(state.shipping.lastSync):'Δεν έχει γίνει συγχρονισμός μεταφορικών.';
    renderTable();calculate();
  }
  for(const button of document.querySelectorAll('[data-shipping-tab]'))button.addEventListener('click',()=>{
    for(const b of document.querySelectorAll('[data-shipping-tab]')){$('#'+b.dataset.shippingTab).hidden=b!==button;b.classList.toggle('active',b===button);b.classList.toggle('quiet',b!==button);}
  });
  $('#shipping-summary-search').addEventListener('input',renderTable);$('#shipping-summary-profile').addEventListener('change',renderTable);
  $('#shipping-calc-form').addEventListener('submit',e=>{e.preventDefault();calculate();});
  for(const id of ['shipping-calc-country','shipping-calc-weight','shipping-calc-value'])$('#'+id).addEventListener('change',calculate);
  return {render,reset(){state=null;$('#shipping-calc-form').reset();$('#shipping-calc-results').textContent='';$('#shipping-summary-grid').textContent='';$('#shipping-summary-search').value='';}};
}
