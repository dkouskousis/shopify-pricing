export function shippingTableUI({ $, api, action, notify, load, escape, euros, date }) {
  let state, page = null, cells = [], dirty = false, plan = null, pending = false, working = false;
  const key = source => JSON.stringify([source.profileId,source.groupId,source.zoneId,source.methodId]);
  const fields = row => ({profileId:row.profileId,groupId:row.groupId,zoneId:row.zoneId,methodId:row.methodId});
  const factors={KILOGRAMS:1,GRAMS:.001,POUNDS:.45359237,OUNCES:.028349523125};
  function sources(includeReadonly=false) {
    const options=new Map();
    for (const row of state?.shipping.rows ?? []) if ((row.active || includeReadonly) && row.type!=='FreeCondition' && (includeReadonly || row.editable&&row.currency==='EUR')) {
      const id=key(row);if (!options.has(id)) options.set(id,{...fields(row),label:`${row.zoneName} · ${row.name} · ${row.profileName}${row.active?'':' · Ανενεργή'}`,rows:[]});options.get(id).rows.push(row);
    }
    return options;
  }
  function choice(value, options, attrs) {
    return `<select ${attrs}><option value="">Χωρίς αντιστοίχιση</option>${[...options].map(([id,s])=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(s.label)}</option>`).join('')}${value&&!options.has(value)?`<option value="${escape(value)}" selected>Η αντιστοίχιση δεν υπάρχει πλέον · επίλεξε ξανά</option>`:''}</select>`;
  }
  function match(rows,weight) {
    if (rows.some(r=>r.conditions.some(c=>c.field!=='TOTAL_WEIGHT'))) return {note:'Ανά αξία καλαθιού'};
    const eligible=rows.filter(r=>r.conditions.every(c=>{
      const factor=factors[c.conditionCriteria.unit];if(!factor)return false;
      const limit=c.conditionCriteria.value*factor;
      return c.operator==='GREATER_THAN_OR_EQUAL_TO'?weight+1e-9>=limit:weight-1e-9<=limit;
    }));
    if(eligible.length!==1)return{note:eligible.length?'Πολλαπλές χρεώσεις':'—'};
    const r=eligible[0];return r.price===null?{note:'Αυτόματη χρέωση'}:r.currency!=='EUR'?{note:(r.price/100).toFixed(2)+' '+r.currency}:{price:r.price};
  }
  function initialize(nextPage, config) {
    page=nextPage;dirty=false;
    const options=sources();
    if(config?.layoutSignature===page.table.layoutSignature) cells=config.cells.map(row=>row.map(c=>c?key(c):''));
    else cells=page.table.rows.map(()=>page.table.headers.slice(1).map(header=>{
      const normalized=header.replace(/^DHL\s+/i,'').trim().toLowerCase();
      const matches=[...options].filter(([,s])=>s.rows[0].zoneName.replace(/^DHL\s+/i,'').trim().toLowerCase()===normalized);
      return matches.length===1?matches[0][0]:'';
    }));
  }
  function renderEditor() {
    const options=sources(),busy=working||state.job.running||state.job.priceSaving||state.job.costSaving;
    $('#public-table-load').disabled=busy;$('#public-table-preview').disabled=busy||!page;$('#public-table-mapping-save').disabled=busy||!page;
    $('#public-table-info').textContent=page?`${page.title} · /pages/${page.handle} · Τελευταία δημοσίευση: ${date(state.shipping.publicTable?.lastPublished)}${dirty?' · Έχεις αλλαγές αντιστοίχισης':''}`:'Φόρτωσε τον υπάρχοντα πίνακα της σελίδας.';
    if(!page){$('#public-table-grid').textContent='';return;}
    $('#public-table-grid').innerHTML=`<table class="public-mapping-table"><thead><tr>${page.table.headers.map((h,j)=>`<th>${escape(h)}${j?choice('',options,`data-table-column="${j-1}" aria-label="Ζώνη για όλη τη στήλη ${escape(h)}" ${busy?'disabled':''}`):''}</th>`).join('')}</tr></thead><tbody>${page.table.rows.map((row,i)=>`<tr><th>${escape(row[0])}</th>${row.slice(1).map((value,j)=>{
      const source=options.get(cells[i][j]),proposed=source?match(source.rows,page.table.weights[i]):null;
      return `<td><strong>${proposed?.price!==undefined?euros(proposed.price):escape(value)}</strong><small>Σελίδα: ${escape(value)}</small>${choice(cells[i][j],options,`data-table-cell="${i},${j}" aria-label="Ζώνη για ${escape(row[0])}, ${escape(page.table.headers[j+1])}" ${busy?'disabled':''}`)}${proposed?.note?`<small class="negative">${escape(proposed.note)}</small>`:''}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function renderReference() {
    if(!$('#public-table-reference').open||!state)return;
    const options=[...sources(true).values()],weights=new Set(page?.table.weights??[]);
    for(const s of options)for(const r of s.rows)for(const c of r.conditions)if(c.field==='TOTAL_WEIGHT'&&c.operator==='LESS_THAN_OR_EQUAL_TO'&&factors[c.conditionCriteria.unit])weights.add(Number((c.conditionCriteria.value*factors[c.conditionCriteria.unit]).toFixed(3)));
    const sorted=[...weights].filter(w=>w>0).sort((a,b)=>a-b);
    $('#public-table-reference-grid').innerHTML=options.length&&sorted.length?`<table><thead><tr><th>kg</th>${options.map(s=>`<th>${escape(s.label)}</th>`).join('')}</tr></thead><tbody>${sorted.map(w=>`<tr><th>${w}</th>${options.map(s=>{const value=match(s.rows,w);return`<td>${value.price!==undefined?euros(value.price):escape(value.note)}</td>`;}).join('')}</tr>`).join('')}</tbody></table>`:'Δεν υπάρχουν συγχρονισμένες κλίμακες βάρους.';
  }
  function render(next) {
    state=next;
    const saved=state.shipping.publicTable;
    if(!page&&saved?.page)initialize(saved.page,saved.config);
    renderEditor();renderReference();
  }
  for(const button of document.querySelectorAll('[data-shipping-tab]'))button.addEventListener('click',()=>{
    for(const b of document.querySelectorAll('[data-shipping-tab]')){$('#'+b.dataset.shippingTab).hidden=b!==button;b.classList.toggle('active',b===button);b.classList.toggle('quiet',b!==button);}
  });
  async function run(button, work) {
    working=true;renderEditor();
    try { await action(button,work); } finally { working=false;renderEditor(); }
  }
  $('#public-table-reference').addEventListener('toggle',renderReference);
  $('#public-table-grid').addEventListener('change',e=>{
    if(e.target.dataset.tableCell!==undefined){const[i,j]=e.target.dataset.tableCell.split(',').map(Number);cells[i][j]=e.target.value;}
    else if(e.target.dataset.tableColumn!==undefined){const j=Number(e.target.dataset.tableColumn);for(const row of cells)row[j]=e.target.value;}
    else return;dirty=true;plan=null;renderEditor();
  });
  $('#public-table-load').addEventListener('click',e=>run(e.currentTarget,async()=>{
    const result=await api('shipping/public-table/load',{});initialize(result,state.shipping.publicTable?.config);await load();notify('Ο πίνακας φορτώθηκε. Οι στήλες και οι γραμμές διατηρούνται.');
  }));
  function mapping() {
    const options=sources();
    return {layoutSignature:page.table.layoutSignature,cells:cells.map(row=>row.map(value=>{if(!value)return null;const source=options.get(value);if(!source)throw new Error('Κάποια αντιστοίχιση δεν υπάρχει πλέον. Επίλεξε ζώνη ξανά.');return fields(source);}))};
  }
  $('#public-table-mapping-save').addEventListener('click',e=>run(e.currentTarget,async()=>{
    await api('shipping/public-table/mapping',mapping());dirty=false;await load();notify('Οι αντιστοιχίσεις κελιών και ζωνών αποθηκεύτηκαν.');
  }));
  $('#public-table-preview').addEventListener('click',e=>run(e.currentTarget,async()=>{
    const config=mapping();
    plan=await api('shipping/public-table/preview',config);dirty=false;
    $('#public-table-preview-grid').innerHTML=`<table><thead><tr>${plan.matrix.headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${plan.matrix.rows.map((row,i)=>`<tr>${row.map((value,j)=>`<${j?'td':'th'}>${escape(value)}${j&&value!==plan.page.table.rows[i][j]?`<small>Πριν: ${escape(plan.page.table.rows[i][j])}</small>`:''}</${j?'td':'th'}>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('#public-table-publish').disabled=!plan.changed;$('#public-table-dialog').showModal();
  }));
  $('#public-table-close').addEventListener('click',()=>{if(!pending)$('#public-table-dialog').close();});
  $('#public-table-dialog').addEventListener('cancel',e=>{if(pending)e.preventDefault();});
  $('#public-table-publish').addEventListener('click',e=>run(e.currentTarget,async()=>{
    if(!plan||pending)return;pending=true;$('#public-table-close').disabled=true;
    try{
      const result=await api('shipping/public-table/publish',{id:plan.id});plan=null;$('#public-table-dialog').close();page=null;await load();notify(result.changed?'Οι τιμές του πίνακα ενημερώθηκαν στη σελίδα.':'Οι τιμές της σελίδας είναι ήδη ενημερωμένες.');
    }finally{pending=false;$('#public-table-close').disabled=false;}
  }));
  return {render,reset(){page=null;cells=[];plan=null;dirty=false;$('#public-table-dialog').close();}};
}
