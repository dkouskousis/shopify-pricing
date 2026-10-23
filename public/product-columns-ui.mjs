import {PRODUCT_COLUMNS,columnPreferences} from './product-columns.mjs';
export function productColumnsUI({$,api,load,action,notify,escape}){
  let saved=columnPreferences(),draft=null,pending=false,dragging=null,resizing=null,widthSaving=false;
  const head=$('#product-table thead tr');
  [...head.children].forEach((cell,i)=>{
    const id=PRODUCT_COLUMNS[i].id;cell.dataset.column=id;
    const handle=document.createElement('span');handle.className='column-resizer';handle.dataset.resizeColumn=id;handle.title='Σύρε για αλλαγή πλάτους';handle.setAttribute('aria-hidden','true');cell.append(handle);
  });
  const defaults={select:48,product:320,status:125,inventory:165,weight:110,cost:140,price:140,newPrice:140,gain:125,fixed:135,vat:90,profit:155,margin:165,actions:70};
  function sizes(){
    const cols=document.createElement('colgroup');let total=0;
    for(const id of saved.order){if(saved.hidden.includes(id))continue;const col=document.createElement('col');const width=saved.widths[id]??defaults[id];col.style.width=width+'px';total+=width;cols.append(col);}
    const table=$('#product-table');table.querySelector('colgroup')?.remove();table.prepend(cols);table.style.width=total+'px';
  }
  head.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('[data-resize-column]');if(!handle||widthSaving||e.button!==0)return;
    e.preventDefault();const id=handle.dataset.resizeColumn;resizing={id,x:e.clientX,width:saved.widths[id]??defaults[id],before:structuredClone(saved)};handle.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove',e=>{if(!resizing)return;saved.widths[resizing.id]=Math.max(48,Math.min(1200,Math.round(resizing.width+e.clientX-resizing.x)));sizes();});
  async function finish(cancel=false){
    if(!resizing)return;const before=resizing.before;resizing=null;if(cancel){saved=before;apply();return;}
    widthSaving=true;try{await api('preferences/products',saved);}catch(e){saved=before;apply();notify(e.message,true);}finally{widthSaving=false;}
  }
  head.addEventListener('pointerup',()=>finish());head.addEventListener('pointercancel',()=>finish(true));

  function apply(){
    sizes();
    const hidden=new Set(saved.hidden),visible=saved.order.length-hidden.size;
    for(const row of [head,...$('#product-rows').children]){
      if(row.children.length===1&&row.firstElementChild.classList.contains('empty')){row.firstElementChild.colSpan=visible;continue;}
      const cells=[...row.children];
      if(!cells[0]?.dataset.column)cells.forEach((cell,i)=>cell.dataset.column=PRODUCT_COLUMNS[i].id);
      const byId=new Map(cells.map(cell=>[cell.dataset.column,cell]));
      for(const id of saved.order){const cell=byId.get(id);cell.hidden=hidden.has(id);row.append(cell);}
    }
  }
  function editor(){
    const scrollTop=$('#product-column-list').scrollTop;
    $('#product-column-list').innerHTML=draft.order.filter(id=>id!=='select').map(id=>{
      const c=PRODUCT_COLUMNS.find(c=>c.id===id),i=draft.order.indexOf(id);
      return `<li data-column-item="${id}" draggable="${!pending}"><span class="column-grip" aria-hidden="true">⠿</span><label class="check"><input type="checkbox" data-column-visible="${id}" ${draft.hidden.includes(id)?'':'checked'} ${pending||c.required?'disabled':''}>${escape(c.label)}</label><label class="column-width">px<input type="number" min="48" max="1200" step="1" data-column-width="${id}" value="${draft.widths[id]??defaults[id]}" ${pending?'disabled':''}></label><div class="actions"><button type="button" class="quiet" data-column-move="${id}" data-step="-1" aria-label="Μετακίνηση ${escape(c.label)} αριστερά" ${pending||i===1?'disabled':''}>↑</button><button type="button" class="quiet" data-column-move="${id}" data-step="1" aria-label="Μετακίνηση ${escape(c.label)} δεξιά" ${pending||i===draft.order.length-1?'disabled':''}>↓</button></div></li>`;
    }).join('');
    $('#product-column-list').scrollTop=scrollTop;
    $('#product-columns-save').disabled=pending;$('#product-columns-close').disabled=pending;$('#product-columns-reset').disabled=pending;
  }
  $('#product-columns-open').addEventListener('click',()=>{if(resizing||widthSaving)return;draft=structuredClone(saved);editor();$('#product-columns-dialog').showModal();});
  $('#product-columns-close').addEventListener('click',()=>{if(!pending)$('#product-columns-dialog').close();});
  $('#product-columns-dialog').addEventListener('cancel',e=>{if(pending)e.preventDefault();});
  $('#product-columns-reset').addEventListener('click',()=>{draft=columnPreferences();editor();});
  $('#product-column-list').addEventListener('change',e=>{const widthId=e.target.dataset.columnWidth;if(widthId&&!pending){const w=Number(e.target.value);if(Number.isInteger(w)&&w>=48&&w<=1200)draft.widths[widthId]=w;else{e.target.value=draft.widths[widthId]??defaults[widthId];notify('Το πλάτος πρέπει να είναι από 48 έως 1.200 px.',true);}return;}const id=e.target.dataset.columnVisible;if(!id||pending)return;draft.hidden=e.target.checked?draft.hidden.filter(x=>x!==id):[...draft.hidden,id];});
  $('#product-column-list').addEventListener('click',e=>{const button=e.target.closest('[data-column-move]');if(!button||pending)return;const i=draft.order.indexOf(button.dataset.columnMove),j=i+Number(button.dataset.step);if(j<1||j>=draft.order.length)return;[draft.order[i],draft.order[j]]=[draft.order[j],draft.order[i]];editor();});
  const list=$('#product-column-list');
  list.addEventListener('dragstart',e=>{if(pending||e.target.closest('input,button')){e.preventDefault();return;}dragging=e.target.closest('[data-column-item]')?.dataset.columnItem;if(dragging){e.dataTransfer.setData('text/plain',dragging);e.dataTransfer.effectAllowed='move';}});
  list.addEventListener('dragover',e=>{if(dragging&&!pending&&e.target.closest('[data-column-item]'))e.preventDefault();});
  list.addEventListener('drop',e=>{const target=e.target.closest('[data-column-item]')?.dataset.columnItem;if(!dragging||!target||pending)return;e.preventDefault();const i=draft.order.indexOf(dragging),j=draft.order.indexOf(target);draft.order.splice(i,1);draft.order.splice(j,0,dragging);dragging=null;editor();});
  list.addEventListener('dragend',()=>{dragging=null;});
  $('#product-columns-save').addEventListener('click',e=>action(e.currentTarget,async()=>{pending=true;editor();try{await api('preferences/products',draft);$('#product-columns-dialog').close();await load();notify('Η διάταξη των στηλών αποθηκεύτηκε.');}finally{pending=false;editor();}}));
  return {render(value){if(!resizing&&!widthSaving)saved=columnPreferences(value);apply();},reset(){$('#product-columns-dialog').close();saved=columnPreferences();draft=null;}};
}
