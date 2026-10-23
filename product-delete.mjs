import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export const DELETE_QUERIES={
  product:`query ProductDeleteDetails($id:ID!){product(id:$id){id title updatedAt variantsCount{count precision}}}`,
  remove:`mutation DeleteCatalogProduct($input:ProductDeleteInput!){productDelete(input:$input,synchronous:false){productDeleteOperation{id}userErrors{field message}}}`,
  operation:`query ProductDeletionStatus($id:ID!){productOperation(id:$id){... on ProductDeleteOperation{id status deletedProductId userErrors{field message}}}}`,
};
export function createProductDelete({store,graphql,startJob,jobState,safeError,stopping,invalidate,pause=delay}){
  const confirmations=new Map(),db=store.db;
  async function product(id){return(await graphql()(DELETE_QUERIES.product,{id})).product;}
  async function remove(confirmation){
    const p=confirmation.product;jobState().total=1;
    const audit=db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail,kind,old_text,new_text) VALUES (?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),p.id,p.title,0,0,'pending','Διαγραφή ολόκληρου προϊόντος','delete',p.title,'Διαγραφή');
    let sending=false,accepted=false,operationId=null;
    try{
      const fresh=await product(p.id);
      if(!fresh||fresh.id!==p.id||fresh.title!==p.title||fresh.updatedAt!==p.updatedAt||fresh.variantsCount?.count!==p.variantsCount.count||fresh.variantsCount?.precision!==p.variantsCount.precision)throw new Error('Το προϊόν άλλαξε. Άνοιξε ξανά τη διαγραφή και έλεγξε τα στοιχεία.');
      sending=true;const result=(await graphql()(DELETE_QUERIES.remove,{input:{id:p.id}})).productDelete;
      if(result.userErrors.length){sending=false;throw new Error(result.userErrors.map(e=>e.message).join('; '));}
      accepted=true;operationId=result.productDeleteOperation?.id;
      if(!operationId)throw new Error('Δεν επιστράφηκε αναγνωριστικό διαγραφής. Έλεγξε το Shopify.');
      const deadline=Date.now()+15*60000;
      while(true){
        if(stopping()||Date.now()>deadline)throw new Error('Η παρακολούθηση της διαγραφής σταμάτησε. Έλεγξε το Shopify πριν δοκιμάσεις ξανά.');
        const op=(await graphql()(DELETE_QUERIES.operation,{id:operationId})).productOperation;
        if(!op||op.id!==operationId)throw new Error('Δεν επιβεβαιώθηκε η εργασία διαγραφής.');
        if(op.status==='COMPLETE'){
          if(op.userErrors.length){sending=false;throw new Error(op.userErrors.map(e=>e.message).join('; '));}
          if(op.deletedProductId!==p.id)throw new Error('Δεν επιβεβαιώθηκε το σωστό προϊόν στη διαγραφή.');
          break;
        }
        if(!['CREATED','ACTIVE'].includes(op.status))throw new Error('Μη αναγνωρίσιμη κατάσταση διαγραφής.');
        await pause(1000);
      }
      if(await product(p.id))throw new Error('Το προϊόν εξακολουθεί να εμφανίζεται στο Shopify. Απαιτείται έλεγχος.');
      db.exec('BEGIN');
      try{
        db.prepare("DELETE FROM variants WHERE json_extract(data,'$.productId')=?").run(p.id);invalidate();
        db.prepare("UPDATE audit SET status='success',detail='Διαγράφηκε ολόκληρο το προϊόν και όλες οι παραλλαγές του',new_text='Διαγράφηκε' WHERE id=?").run(audit.lastInsertRowid);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      jobState().completed=1;jobState().message=`Διαγράφηκε το προϊόν «${p.title}» και όλες οι παραλλαγές του.`;
    }catch(error){db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending||accepted?'uncertain':'failed',safeError(error)+(operationId?' · '+operationId:''),audit.lastInsertRowid);throw error;}
  }
  async function handle(path,input){
    for(const[id,c]of confirmations)if(c.expires<Date.now())confirmations.delete(id);
    if(path==='/api/product-delete/details'){
      const cached=store.variant(input.variantId);if(!cached)throw new Error('Δεν βρέθηκε το προϊόν.');
      const p=await product(cached.productId);if(!p||p.id!==cached.productId)throw new Error('Το προϊόν δεν υπάρχει πλέον στο Shopify. Συγχρόνισε τη λίστα.');
      if(!p.variantsCount||p.variantsCount.precision!=='EXACT')throw new Error('Δεν επιβεβαιώθηκε το πλήθος παραλλαγών. Έλεγξε το Shopify.');
      const token=randomBytes(24).toString('hex'),expires=Date.now()+5*60000;
      confirmations.set(token,{product:p,expires});return {token,expires,product:p};
    }
    if(path==='/api/product-delete/confirm'){
      const c=confirmations.get(input.token);
      if(!c||c.expires<Date.now())throw new Error('Η επιβεβαίωση έληξε ή χρησιμοποιήθηκε. Άνοιξε ξανά τη διαγραφή.');
      if(input.confirmTitle!==c.product.title)throw new Error('Πληκτρολόγησε ακριβώς το όνομα του προϊόντος για επιβεβαίωση.');
      confirmations.delete(input.token);startJob('product-delete',()=>remove(c));return {ok:true};
    }
    throw new Error('Άγνωστη ενέργεια διαγραφής.');
  }
  return {handle};
}
