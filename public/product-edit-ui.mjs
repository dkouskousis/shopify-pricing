export function productEditUI({$,api,action,load,escape,notify,selection}) {
  let state,ids=[],details=null,pending=false,waiting=false,shown=null;
  const form=$('#product-edit-form');
  const decimal=n=>n===null||n===undefined?'—':new Intl.NumberFormat('el-GR',{maximumFractionDigits:6}).format(n);
  const field=()=>form.elements.field.value;
  function fields(){
    const inventory=field()==='inventory',single=ids.length===1&&details!==null;
    $('#edit-inventory-fields').hidden=!inventory;$('#edit-weight-fields').hidden=inventory;
    $('#edit-single-settings').hidden=!single;$('#edit-bulk-settings').hidden=single;
    $('#edit-location-table').hidden=!single;$('#edit-bulk-quantity').hidden=single;
    $('#edit-weight-current').textContent=single?'Τωρινό βάρος: '+decimal(details.snapshot.weightKg)+' kg':'';
    for(const e of form.querySelectorAll('input,select'))if(e.name!=='field')e.disabled=pending||e.dataset.unavailable==='true'||Boolean(e.closest('[hidden]'));
    $('#product-edit-close').disabled=pending;
  }
  function locations(options){
    const current=$('#edit-location').value;$('#edit-location').innerHTML='<option value="">Χωρίς αλλαγή ποσότητας</option>'+options.map(l=>`<option value="${escape(l.id)}" ${l.isActive?'':'disabled'}>${escape(l.name)}${l.isActive?'':' · Ανενεργή'}</option>`).join('');
    if(options.some(l=>l.id===current&&l.isActive))$('#edit-location').value=current;
    if(!details)return;
    $('#edit-location-rows').innerHTML=options.map(l=>{
      const level=details.snapshot.levels.find(x=>x.locationId===l.id),active=level?.active;
      return `<tr><td><strong>${escape(l.name)}</strong><small>${!l.isActive?'Ανενεργή αποθήκη':active?'Αποθηκεύεται εδώ':'Δεν αποθηκεύεται εδώ · συμπλήρωση ποσότητας ενεργοποιεί τη θέση'}</small></td><td>${active?decimal(level.available):'—'}${active?`<small>Δεσμευμένα: ${decimal(level.committed)} · Στο χέρι: ${decimal(level.onHand)}</small>`:''}</td><td><input name="location-${escape(l.id)}" data-edit-location="${escape(l.id)}" inputmode="numeric" placeholder="Διατήρηση" aria-label="Νέα διαθέσιμη ποσότητα στην ${escape(l.name)}" ${l.isActive?'':'data-unavailable="true" disabled'}></td></tr>`;
    }).join('');
  }
  async function open(nextIds,nextField) {
    ids=nextIds;details=null;shown=null;form.reset();form.elements.field.value=nextField;form.elements.field.disabled=ids.length===1;
    const product=ids.length===1?state.products.find(p=>p.id===ids[0]):null;
    $('#product-edit-label').textContent=product?`${product.title} / ${product.variant} · SKU: ${product.sku||'—'}`:`${ids.length} επιλεγμένες παραλλαγές`;
    pending=true;fields();$('#product-edit-dialog').showModal();$('#product-edit-submit').disabled=true;$('#product-edit-loading').hidden=false;
    try {
      if(ids.length===1){details=await api('product-edit/details',{id:ids[0]});$('#edit-tracked').checked=details.snapshot.tracked;$('#edit-backorder').checked=details.snapshot.inventoryPolicy==='CONTINUE';form.elements.weightValue.value=details.snapshot.weightKg===null?'':String(details.snapshot.weightKg);locations(details.locations);}
      else {const result=await api('product-edit/options',{});locations(result.locations);}
    }catch(error){$('#product-edit-dialog').close();throw error;}
    finally{pending=false;$('#product-edit-loading').hidden=true;fields();$('#product-edit-submit').disabled=false;}
  }
  $('#product-rows').addEventListener('click',e=>{const button=e.target.closest('[data-edit-inventory],[data-edit-weight]');if(!button)return;action(button,()=>open([button.dataset.editInventory??button.dataset.editWeight],button.dataset.editInventory?'inventory':'weight'));});
  $('#bulk-product-edit').addEventListener('click',e=>action(e.currentTarget,()=>open(selection(),'inventory')));
  form.elements.field.addEventListener('change',fields);
  $('#product-edit-close').addEventListener('click',()=>{if(!pending)$('#product-edit-dialog').close();});
  $('#product-edit-dialog').addEventListener('cancel',e=>{if(pending)e.preventDefault();});
  form.addEventListener('submit',event=>{event.preventDefault();action(event.submitter,async()=>{
    if(pending)return;let data;
    if(field()==='weight')data={mode:form.elements.weightMode.value,value:form.elements.weightValue.value};
    else if(details)data={tracked:$('#edit-tracked').checked,policy:$('#edit-backorder').checked?'CONTINUE':'DENY',quantities:[...form.querySelectorAll('[data-edit-location]')].filter(e=>!e.disabled&&e.value.trim()!=='').map(e=>({locationId:e.dataset.editLocation,mode:'set',value:e.value.trim()}))};
    else {const tracked=form.elements.bulkTracked.value,policy=form.elements.bulkPolicy.value,locationId=$('#edit-location').value,value=form.elements.quantity.value.trim();
      if(locationId&&!value)throw new Error('Συμπλήρωσε ποσότητα για την επιλεγμένη αποθήκη.');
      if(!locationId&&value)throw new Error('Επίλεξε αποθήκη για την αλλαγή ποσότητας.');
      data={tracked:tracked===''?null:tracked==='true',policy:policy||null,quantities:locationId?[{locationId,mode:form.elements.quantityMode.value,value}]:[]};
    }
    pending=true;fields();
    try{await api('product-edit/preview',{ids,field:field(),data,...(details?{expected:details.fingerprints[field()]}:{})});waiting=true;$('#product-edit-dialog').close();await load();}
    finally{pending=false;fields();}
  });});
  $('#product-edit-preview-close').addEventListener('click',()=>$('#product-edit-preview-dialog').close());
  $('#product-edit-apply').addEventListener('click',event=>action(event.currentTarget,async()=>{
    if(!state.productEdit||pending)return;pending=true;$('#product-edit-preview-close').disabled=true;
    try{await api('product-edit/apply',{id:state.productEdit.id});$('#product-edit-preview-dialog').close();await load();}
    finally{pending=false;$('#product-edit-preview-close').disabled=false;}
  }));
  $('#product-edit-preview-dialog').addEventListener('cancel',e=>{if(pending)e.preventDefault();});
  function render(next){
    state=next;$('#bulk-product-edit').hidden=$('#selection-purpose').value!=='manual';$('#bulk-product-edit').disabled=!selection().length||state.job.running||state.job.priceSaving||state.job.costSaving;
    const plan=state.productEdit;
    if(waiting&&!state.job.running){waiting=false;if(state.job.error)return;}
    if(!plan||plan.id===shown||state.job.running)return;
    shown=plan.id;const valid=plan.items.filter(i=>i.changed&&!i.error),errors=plan.items.filter(i=>i.error);
    $('#product-edit-preview-title').textContent=plan.field==='weight'?'Προεπισκόπηση βάρους':'Προεπισκόπηση αποθέματος';
    $('#product-edit-preview-note').textContent=`${valid.length} αλλαγές · ${errors.length} με σφάλμα · ${plan.items.length-valid.length-errors.length} χωρίς αλλαγή. Τα σφάλματα εξαιρούνται από την εφαρμογή.`;
    $('#product-edit-preview-rows').innerHTML=plan.items.map(i=>`<tr><td>${escape(i.title)}<small>${escape(i.sku)}</small></td><td>${escape(i.oldText??'—')}</td><td>${i.error?`<span class="negative">${escape(i.error)}</span>`:escape(i.newText)}</td><td>${i.error?'Σφάλμα':i.changed?'Θα ενημερωθεί':'Ίδιο'}</td></tr>`).join('');
    $('#product-edit-apply').disabled=!valid.length;$('#product-edit-preview-dialog').showModal();
  }
  return{render,selectionChanged(){if(!state)return;$('#bulk-product-edit').hidden=$('#selection-purpose').value!=='manual';$('#bulk-product-edit').disabled=!selection().length||state.job.running||state.job.priceSaving||state.job.costSaving;},reset(){state=null;details=null;ids=[];shown=null;waiting=false;$('#product-edit-dialog').close();$('#product-edit-preview-dialog').close();}};
}
