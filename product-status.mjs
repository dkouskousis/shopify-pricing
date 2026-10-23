export const STATUS_QUERIES={
  read:`query ProductStatusDetails($id:ID!){product(id:$id){id title status}}`,
  update:`mutation UpdateProductStatus($product:ProductUpdateInput!){productUpdate(product:$product){product{id status}userErrors{field message}}}`,
};
export const PRODUCT_STATUSES=['ACTIVE','DRAFT','ARCHIVED','UNLISTED'];
export function createProductStatus({store,graphql,startJob,jobState,safeError,stopping,invalidate}){
  const db=store.db;
  const read=async id=>(await graphql()(STATUS_QUERIES.read,{id})).product;
  return {async handle(path,input){
    if(path==='/api/product-status/details'){
      const v=store.variant(input.id);if(!v)throw new Error('Δεν βρέθηκε το προϊόν.');
      const p=await read(v.productId);if(!p||p.id!==v.productId)throw new Error('Το προϊόν δεν υπάρχει πλέον στο Shopify.');return p;
    }
    if(path!=='/api/product-status/save')throw new Error('Άγνωστη ενέργεια κατάστασης.');
    if(!PRODUCT_STATUSES.includes(input.status)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>2000||new Set(input.ids).size!==input.ids.length)throw new Error('Επίλεξε κατάσταση και 1–2.000 παραλλαγές.');
    if(input.expected!==undefined&&(input.ids.length!==1||!PRODUCT_STATUSES.includes(input.expected)))throw new Error('Μη έγκυρη προηγούμενη κατάσταση.');
    const products=new Map();
    for(const id of input.ids){const v=store.variant(id);if(!v)throw new Error('Δεν βρέθηκε επιλεγμένο προϊόν.');products.set(v.productId,{...v,expected:input.expected??v.status});}
    startJob('product-status',async()=>{
      jobState().total=products.size;let success=0,failed=0,unchanged=0;
      for(const [id,v]of products){
        if(stopping())throw new Error('Η εργασία διακόπηκε. Έλεγξε το ιστορικό.');
        let audit=null,sending=false;
        try{
          const p=await read(id);if(!p||p.id!==id)throw new Error('Το προϊόν δεν υπάρχει πλέον στο Shopify.');
          if(p.status!==v.expected)throw new Error('Η κατάσταση άλλαξε στο Shopify. Συγχρόνισε τη λίστα και δοκίμασε ξανά.');
          if(p.status===input.status){unchanged++;continue;}
          audit=db.prepare('INSERT INTO audit(created,variant_id,title,sku,old_price,new_price,status,detail,kind,old_text,new_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),id,p.title,v.sku??'',0,0,'pending','Αλλαγή κατάστασης προϊόντος','status',p.status,input.status).lastInsertRowid;
          sending=true;const result=(await graphql()(STATUS_QUERIES.update,{product:{id,status:input.status}})).productUpdate;
          if(result.userErrors.length){sending=false;throw new Error(result.userErrors.map(e=>e.message).join('; '));}
          if(result.product?.id!==id||result.product.status!==input.status)throw new Error('Δεν επιβεβαιώθηκε η νέα κατάσταση.');
          const after=await read(id);if(after?.id!==id||after.status!==input.status)throw new Error('Δεν επιβεβαιώθηκε η αποθήκευση στο Shopify.');
          db.exec('BEGIN');try{db.prepare("UPDATE variants SET data=json_set(data,'$.status',?) WHERE json_extract(data,'$.productId')=?").run(after.status,id);invalidate();db.prepare("UPDATE audit SET status='success',detail='Ενημερώθηκε ολόκληρο το προϊόν και όλες οι παραλλαγές του' WHERE id=?").run(audit);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}success++;
        }catch(e){failed++;if(audit!==null)db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending?'uncertain':'failed',safeError(e),audit);else db.prepare('INSERT INTO audit(created,variant_id,title,sku,old_price,new_price,status,detail,kind,old_text,new_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),id,v.title,v.sku??'',0,0,'failed',safeError(e),'status',v.expected,input.status);}
        finally{jobState().completed++;}
      }
      jobState().message=`Κατάσταση προϊόντων: ${success} ενημερώθηκαν, ${unchanged} χωρίς αλλαγή, ${failed} χρειάζονται έλεγχο.`;
    });return {ok:true};
  }};
}
