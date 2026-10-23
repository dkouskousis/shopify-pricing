import {createHash,randomUUID,randomBytes} from 'node:crypto';
const factors={KILOGRAMS:1,GRAMS:.001,POUNDS:.45359237,OUNCES:.028349523125};
export function inventoryFields(v) {
  const w=v.inventoryItem.measurement?.weight;
  return {inventoryItemId:v.inventoryItem.id??null,tracked:v.inventoryItem.tracked??null,inventoryPolicy:v.inventoryPolicy??null,
    inventoryQuantity:v.inventoryQuantity??null,weightKg:w?Number((w.value*factors[w.unit]).toFixed(9)):null};
}
export const EDIT_QUERIES={
  locations:`query ProductEditLocations($after:String){locations(first:100,after:$after,includeInactive:true,includeLegacy:true){nodes{id name isActive}pageInfo{hasNextPage endCursor}}}`,
  variant:`query ProductEditVariant($id:ID!){productVariant(id:$id){id inventoryPolicy inventoryQuantity product{id} inventoryItem{id tracked measurement{weight{value unit}}}}}`,
  levels:`query ProductEditLevels($id:ID!,$after:String){inventoryItem(id:$id){id inventoryLevels(first:100,after:$after,includeInactive:true){nodes{id isActive location{id name} quantities(names:["available","on_hand","committed"]){name quantity}}pageInfo{hasNextPage endCursor}}}}`,
  item:`mutation ProductEditItem($id:ID!,$input:InventoryItemInput!){inventoryItemUpdate(id:$id,input:$input){inventoryItem{id}userErrors{field message}}}`,
  policy:`mutation ProductEditPolicy($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id inventoryPolicy}userErrors{field message}}}`,
  quantities:`mutation ProductEditQuantities($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{reason}userErrors{field message}}}`,
  activate:`mutation ProductEditActivate($inventoryItemId:ID!,$locationId:ID!,$key:String!){inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId) @idempotent(key:$key){inventoryLevel{id}userErrors{field message}}}`,
};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const integer=value=>{if(!/^-?\d+$/.test(String(value).trim()))throw new Error('Το απόθεμα πρέπει να είναι ακέραιος αριθμός.');const n=Number(value);if(!Number.isSafeInteger(n)||Math.abs(n)>1000000)throw new Error('Βάλε ποσότητα από -1.000.000 έως 1.000.000.');return n;};
export function changedWeight(current,mode,value) {
  const text=String(value).trim().replace(',','.');if(!/^[+-]?\d+(?:\.\d{1,6})?$/.test(text))throw new Error('Βάλε έγκυρο βάρος ή μεταβολή με έως 6 δεκαδικά.');
  const n=Number(text);if(!['set','fixed','percent'].includes(mode))throw new Error('Μη έγκυρος τρόπος αλλαγής βάρους.');
  if(mode!=='set'&&current===null)throw new Error('Λείπει βάρος. Χρησιμοποίησε ορισμό νέου βάρους.');
  const result=Math.round((mode==='set'?n:mode==='fixed'?current+n:current*(1+n/100))*1e6)/1e6;
  if(!Number.isFinite(result)||result<0||result>1000000)throw new Error('Το βάρος πρέπει να είναι από 0 έως 1.000.000 kg.');return result;
}
export function editFingerprint(snapshot,field) {
  return hash(field==='weight'?[snapshot.id,snapshot.productId,snapshot.inventoryItemId,snapshot.weightKg]:[snapshot.id,snapshot.productId,snapshot.inventoryItemId,snapshot.tracked,snapshot.inventoryPolicy,snapshot.levels.map(l=>[l.locationId,l.active,l.available]).sort((a,b)=>a[0].localeCompare(b[0]))]);
}
async function pages(fetchPage){const all=[],seen=new Set();let after=null;do{const p=await fetchPage(after);all.push(...p.nodes);if(all.length>10000)throw new Error('Υπέρβαση 10.000 αποθηκών.');if(!p.pageInfo.hasNextPage)return all;after=p.pageInfo.endCursor;if(!after||seen.has(after))throw new Error('Μη έγκυρη σελιδοποίηση αποθηκών.');seen.add(after);}while(true);}
function validate(input) {
  if(!['inventory','weight'].includes(input.field))throw new Error('Επίλεξε απόθεμα ή βάρος.');
  if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>2000||new Set(input.ids).size!==input.ids.length||input.ids.some(id=>typeof id!=='string'))throw new Error('Επίλεξε 1–2.000 διαφορετικές παραλλαγές.');
  const data=input.data;if(!data||typeof data!=='object')throw new Error('Λείπουν τα στοιχεία αλλαγής.');
  if(input.expected!==undefined&&(input.ids.length!==1||typeof input.expected!=='string'))throw new Error('Μη έγκυρος έλεγχος προηγούμενων στοιχείων.');
  if(input.field==='weight'){if(!['set','fixed','percent'].includes(data.mode)||!(/^[+-]?\d+(?:[.,]\d{1,6})?$/).test(String(data.value).trim()))throw new Error('Βάλε έγκυρο βάρος ή μεταβολή με έως 6 δεκαδικά.');return;}
  if(![null,true,false].includes(data.tracked)||![null,'CONTINUE','DENY'].includes(data.policy))throw new Error('Μη έγκυρες ρυθμίσεις αποθέματος.');
  if(!Array.isArray(data.quantities)||data.quantities.length>250||new Set(data.quantities.map(q=>q.locationId)).size!==data.quantities.length)throw new Error('Μη έγκυρες αποθήκες.');
  for(const q of data.quantities){if(typeof q.locationId!=='string'||!q.locationId||!['set','fixed'].includes(q.mode))throw new Error('Μη έγκυρη αλλαγή ποσότητας.');integer(q.value);}
  if(data.tracked===false&&data.quantities.length)throw new Error('Δεν μπορείς να αλλάξεις ποσότητα με απενεργοποιημένη παρακολούθηση.');
  if(data.tracked===null&&data.policy===null&&!data.quantities.length)throw new Error('Επίλεξε τουλάχιστον μία αλλαγή.');
}
export function describeEdit(s,field,locations=[]) {
  if(field==='weight')return s.weightKg===null?'Χωρίς βάρος':`${s.weightKg} kg`;
  const names=new Map(locations.map(l=>[l.id,l.name]));
  return `${s.tracked?'Παρακολούθηση: ναι':'Παρακολούθηση: όχι'} · Backorder: ${s.inventoryPolicy==='CONTINUE'?'ναι':'όχι'}${s.tracked?' · '+s.levels.filter(l=>l.active).map(l=>`${names.get(l.locationId)??l.name}: ${l.available}`).join(' / '):''}`;
}
export function createProductEdit({store,graphql,startJob,jobState,safeError,stopping,invalidate}) {
  let plan=null;const db=store.db;
  async function locations(){return pages(async after=>(await graphql()(EDIT_QUERIES.locations,{after})).locations);}
  async function snapshot(id,field='inventory') {
    const v=(await graphql()(EDIT_QUERIES.variant,{id})).productVariant;
    if(!v)throw new Error('Η παραλλαγή δεν υπάρχει πλέον στο Shopify.');
    const result={id:v.id,productId:v.product.id,...inventoryFields(v),levels:[]};
    if(field==='inventory'){
      const levels=await pages(async after=>{const item=(await graphql()(EDIT_QUERIES.levels,{id:result.inventoryItemId,after})).inventoryItem;if(!item||item.id!==result.inventoryItemId)throw new Error('Το είδος αποθέματος άλλαξε.');return item.inventoryLevels;});
      result.levels=levels.map(l=>({id:l.id,locationId:l.location.id,name:l.location.name,active:l.isActive,
        available:l.quantities.find(q=>q.name==='available')?.quantity??null,onHand:l.quantities.find(q=>q.name==='on_hand')?.quantity??null,committed:l.quantities.find(q=>q.name==='committed')?.quantity??null}));
    }
    return result;
  }
  function state(){if(plan&&plan.expires<Date.now())plan=null;return plan?{id:plan.id,expires:plan.expires,field:plan.field,items:plan.items.map(({before,after,...item})=>item)}:null;}
  async function preview(input) {
    const locs=input.field==='inventory'?await locations():[],active=new Set(locs.filter(l=>l.isActive).map(l=>l.id));
    const items=[];jobState().total=input.ids.length;
    for(const id of input.ids){if(stopping())throw new Error('Η προεπισκόπηση διακόπηκε.');const cached=store.variant(id);let item={id,title:cached?`${cached.title} / ${cached.variant}`:id,sku:cached?.sku??''};
      try{
        if(!cached)throw new Error('Δεν βρέθηκε η παραλλαγή.');const before=await snapshot(id,input.field);
        if(before.productId!==cached.productId)throw new Error('Η παραλλαγή άλλαξε προϊόν.');
        const fingerprint=editFingerprint(before,input.field);
        if(input.expected&&input.expected!==fingerprint)throw new Error('Τα στοιχεία άλλαξαν στο Shopify. Άνοιξε ξανά την επεξεργασία.');
        const after=structuredClone(before),data=input.data;
        if(input.field==='weight')after.weightKg=changedWeight(before.weightKg,data.mode,data.value);
        else {
          after.tracked=data.tracked===null?before.tracked:data.tracked;after.inventoryPolicy=data.policy===null?before.inventoryPolicy:data.policy;
          if(data.quantities.length&&!after.tracked)throw new Error('Ενεργοποίησε την παρακολούθηση αποθέματος για αλλαγή ποσότητας.');
          for(const q of data.quantities){if(!active.has(q.locationId))throw new Error('Η επιλεγμένη αποθήκη δεν είναι ενεργή.');
            let level=after.levels.find(l=>l.locationId===q.locationId);
            if(!level||!level.active){if(q.mode!=='set')throw new Error('Το προϊόν δεν έχει απόθεμα στην αποθήκη. Χρησιμοποίησε ορισμό ποσότητας.');
              if(!level){level={locationId:q.locationId,name:locs.find(l=>l.id===q.locationId).name,active:true,available:integer(q.value)};after.levels.push(level);}else{level.active=true;level.available=integer(q.value);}
            }else{if(q.mode!=='set'&&(!before.tracked||level.available===null))throw new Error('Δεν υπάρχει παρακολουθούμενη ποσότητα για προσαρμογή. Χρησιμοποίησε ορισμό ποσότητας.');level.available=integer(q.mode==='set'?q.value:level.available+integer(q.value));}
          }
        }
        item={...item,before,after,fingerprint,oldText:describeEdit(before,input.field,locs),newText:describeEdit(after,input.field,locs),changed:editFingerprint(before,input.field)!==editFingerprint(after,input.field)};
      }catch(error){item.error=safeError(error);}
      items.push(item);jobState().completed++;
    }
    plan={id:randomBytes(24).toString('hex'),expires:Date.now()+15*60000,field:input.field,items,locations:locs};
    jobState().message='Η προεπισκόπηση είναι έτοιμη. Έλεγξε τις αλλαγές πριν τις εφαρμόσεις.';
  }
  function cache(s){const v=store.variant(s.id);db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({...v,inventoryItemId:s.inventoryItemId,inventoryQuantity:s.inventoryQuantity,tracked:s.tracked,inventoryPolicy:s.inventoryPolicy,weightKg:s.weightKg}),s.id);}
  async function apply(p) {
    const items=p.items.filter(i=>i.changed&&!i.error);jobState().total=items.length;let success=0,failed=0;
    for(const item of items){if(stopping())break;
      const audit=db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail,kind,sku,old_text,new_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),item.id,item.title,0,0,'pending','',p.field,item.sku,item.oldText,item.newText);
      let sending=false,written=false;
      async function mutate(query,variables,payloadName){sending=true;const result=(await graphql()(query,variables))[payloadName];if(result.userErrors.length){sending=false;throw new Error(result.userErrors.map(e=>e.message).join('; '));}written=true;sending=false;}
      try{
        let fresh=await snapshot(item.id,p.field);
        if(editFingerprint(fresh,p.field)!==item.fingerprint)throw new Error('Τα στοιχεία άλλαξαν στο Shopify μετά την προεπισκόπηση. Κάνε νέα προεπισκόπηση.');
        if(p.field==='weight')await mutate(EDIT_QUERIES.item,{id:fresh.inventoryItemId,input:{measurement:{weight:{unit:'KILOGRAMS',value:item.after.weightKg}}}},'inventoryItemUpdate');
        else {
          const before=item.before,after=item.after,locs=await locations();
          const changed=after.levels.filter(l=>{const old=before.levels.find(o=>o.locationId===l.locationId);return l.active&&(!old?.active||l.available!==old.available);});
          if(changed.some(l=>!locs.some(x=>x.id===l.locationId&&x.isActive)))throw new Error('Κάποια αποθήκη απενεργοποιήθηκε.');
          if(!before.tracked&&after.tracked){await mutate(EDIT_QUERIES.item,{id:fresh.inventoryItemId,input:{tracked:true}},'inventoryItemUpdate');fresh=await snapshot(item.id);}
          for(const level of changed){
            let old=before.tracked?before.levels.find(l=>l.locationId===level.locationId):fresh.levels.find(l=>l.locationId===level.locationId);
            if(!old?.active){await mutate(EDIT_QUERIES.activate,{inventoryItemId:fresh.inventoryItemId,locationId:level.locationId,key:randomUUID()},'inventoryActivate');fresh=await snapshot(item.id);old=fresh.levels.find(l=>l.locationId===level.locationId);if(!old?.active||old.available!==0)throw new Error('Η νέα θέση αποθέματος δεν επιβεβαιώθηκε με μηδενική ποσότητα. Έλεγξε το Shopify.');}
            if(!Number.isInteger(old.available))throw new Error('Δεν επιβεβαιώθηκε η τωρινή ποσότητα αποθήκης.');
            await mutate(EDIT_QUERIES.quantities,{key:randomUUID(),input:{name:'available',reason:'correction',quantities:[{inventoryItemId:fresh.inventoryItemId,locationId:level.locationId,quantity:level.available,changeFromQuantity:old.available}]}},'inventorySetQuantities');
          }
          if(before.inventoryPolicy!==after.inventoryPolicy)await mutate(EDIT_QUERIES.policy,{productId:fresh.productId,variants:[{id:item.id,inventoryPolicy:after.inventoryPolicy}]},'productVariantsBulkUpdate');
          if(before.tracked&&!after.tracked)await mutate(EDIT_QUERIES.item,{id:fresh.inventoryItemId,input:{tracked:false}},'inventoryItemUpdate');
        }
        const confirmed=await snapshot(item.id,p.field);
        if(p.field==='weight'?confirmed.weightKg===null||Math.abs(confirmed.weightKg-item.after.weightKg)>1e-8:confirmed.tracked!==item.after.tracked||confirmed.inventoryPolicy!==item.after.inventoryPolicy||item.after.tracked&&item.after.levels.some(l=>{const old=item.before.levels.find(o=>o.locationId===l.locationId);if(!l.active||old?.active&&old.available===l.available)return false;const c=confirmed.levels.find(c=>c.locationId===l.locationId);return!c?.active||c.available!==l.available;}))throw new Error('Δεν επιβεβαιώθηκαν όλες οι αλλαγές. Συγχρόνισε και έλεγξε το Shopify.');
        cache(confirmed);db.prepare("UPDATE audit SET status='success',detail='Επιβεβαιώθηκε στο Shopify' WHERE id=?").run(audit.lastInsertRowid);success++;
      }catch(error){failed++;db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending||written?'uncertain':'failed',(written?'Έχουν προηγηθεί εγγραφές· έλεγξε τυχόν μερική ενημέρωση. ':'')+safeError(error),audit.lastInsertRowid);}
      jobState().completed++;invalidate();
    }
    jobState().message=`${success} ενημερώθηκαν, ${failed} χρειάζονται έλεγχο στο ιστορικό.${stopping()?' Η εργασία διακόπηκε.':''}`;
  }
  async function handle(path,input){
    if(path==='/api/product-edit/options')return {locations:await locations()};
    if(path==='/api/product-edit/details'){const cached=store.variant(input.id);if(!cached)throw new Error('Δεν βρέθηκε η παραλλαγή.');const s=await snapshot(input.id);if(s.productId!==cached.productId)throw new Error('Η παραλλαγή άλλαξε προϊόν.');return {snapshot:s,locations:await locations(),fingerprints:{inventory:editFingerprint(s,'inventory'),weight:editFingerprint(s,'weight')}};}
    if(path==='/api/product-edit/preview'){validate(input);plan=null;startJob('product-preview',()=>preview(input));return {ok:true};}
    if(path==='/api/product-edit/apply'){if(!plan||plan.id!==input.id||plan.expires<Date.now())throw new Error('Η προεπισκόπηση έληξε ή χρησιμοποιήθηκε.');if(!plan.items.some(i=>i.changed&&!i.error))throw new Error('Δεν υπάρχουν αλλαγές για εφαρμογή.');const p=plan;plan=null;startJob('product-apply',()=>apply(p));return {ok:true};}
    throw new Error('Άγνωστη ενέργεια προϊόντων.');
  }
  return {state,handle};
}
