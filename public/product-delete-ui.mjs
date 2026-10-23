export function productDeleteUI({$,api,action,load}){
  let confirmation=null,pending=false;
  const form=$('#product-delete-form');
  function fields(){form.elements.confirmTitle.disabled=pending;$('#product-delete-close').disabled=pending;$('#product-delete-confirm').disabled=pending||!confirmation||form.elements.confirmTitle.value!==confirmation.product.title;}
  $('#product-rows').addEventListener('click',event=>{
    const button=event.target.closest('[data-delete-product]');if(!button)return;
    action(button,async()=>{
      confirmation=null;pending=true;form.reset();fields();$('#product-delete-name').textContent='Ανάγνωση προϊόντος από το Shopify…';$('#product-delete-count').textContent='';$('#product-delete-dialog').showModal();
      try{confirmation=await api('product-delete/details',{variantId:button.dataset.deleteProduct});$('#product-delete-name').textContent=confirmation.product.title;$('#product-delete-count').textContent=`Θα διαγραφούν ολόκληρο το προϊόν και οι ${confirmation.product.variantsCount.count} παραλλαγές του. Η διαγραφή είναι οριστική.`;}
      catch(error){$('#product-delete-dialog').close();throw error;}
      finally{pending=false;fields();}
    });
  });
  form.elements.confirmTitle.addEventListener('input',fields);
  $('#product-delete-close').addEventListener('click',()=>{if(!pending)$('#product-delete-dialog').close();});
  $('#product-delete-dialog').addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  form.addEventListener('submit',event=>{event.preventDefault();action(event.submitter,async()=>{
    if(pending||!confirmation)return;pending=true;fields();
    try{await api('product-delete/confirm',{token:confirmation.token,confirmTitle:form.elements.confirmTitle.value});confirmation=null;$('#product-delete-dialog').close();await load();}
    finally{pending=false;fields();}
  });});
  return{reset(){confirmation=null;$('#product-delete-dialog').close();}};
}
