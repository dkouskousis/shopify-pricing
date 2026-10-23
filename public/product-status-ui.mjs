export function productStatusUI({$,api,action,load,selection}){
  let ids=[],expected,pending=false,state;
  const dialog=$('#product-status-dialog'),form=$('#product-status-form');
  function fields(){for(const el of form.elements)el.disabled=pending;$('#product-status-close').disabled=pending;}
  async function open(single){
    ids=single?[single]:selection();expected=undefined;form.reset();pending=true;fields();dialog.showModal();
    try{
      if(single){const p=await api('product-status/details',{id:single});expected=p.status;form.elements.status.value=p.status;$('#product-status-description').textContent=p.title+' — η αλλαγή αφορά όλες τις παραλλαγές.';}
      else{$('#product-status-description').textContent=`${new Set(state.products.filter(p=>ids.includes(p.id)).map(p=>p.productId)).size} προϊόντα. Η αλλαγή αφορά όλες τις παραλλαγές τους.`;}
    }catch(e){dialog.close();throw e;}finally{pending=false;fields();}
  }
  $('#product-rows').addEventListener('click',e=>{const b=e.target.closest('[data-edit-status]');if(b)action(b,()=>open(b.dataset.editStatus));});
  $('#bulk-status').addEventListener('click',e=>action(e.currentTarget,()=>open()));
  $('#product-status-close').addEventListener('click',()=>{if(!pending)dialog.close();});dialog.addEventListener('cancel',e=>{if(pending)e.preventDefault();});
  form.addEventListener('submit',e=>{e.preventDefault();action(e.submitter,async()=>{if(pending)return;pending=true;fields();try{await api('product-status/save',{ids,status:form.elements.status.value,...(expected===undefined?{}:{expected})});dialog.close();await load();}finally{pending=false;fields();}});});
  return {render(s){state=s;},selectionChanged(disabled,manual){$('#bulk-status').hidden=!manual;$('#bulk-status').disabled=disabled;},reset(){ids=[];dialog.close();}};
}
