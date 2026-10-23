import {randomUUID} from 'node:crypto';
import {createApplication} from '../../server.mjs';
import {inventoryFields} from '../../product-edit.mjs';
export const variantId=n=>`gid://shopify/ProductVariant/${n}`;
export const locationId=n=>`gid://shopify/Location/${n}`;
const info={hasNextPage:false,endCursor:null};
export async function productHarness(t,count=2,port=0) {
  const config={appUrl:'http://localhost'+(port?':'+port:''),password:'inventory-fixture-password',encryptionKey:'ef'.repeat(32),dbPath:':memory:'};
  const locations=[{id:locationId(1),name:'Athens',isActive:true},{id:locationId(2),name:'Chios',isActive:true},{id:locationId(3),name:'Warehouse 3',isActive:true},{id:locationId(4),name:'Inactive',isActive:false}];
  const variants=Array.from({length:count},(_,i)=>({id:variantId(i+1),title:'Medium',price:'100.00',compareAtPrice:null,taxable:true,inventoryPolicy:'DENY',
    inventoryItem:{id:`gid://shopify/InventoryItem/${i+1}`,sku:`TEST-${i+1}`,tracked:true,measurement:{weight:{unit:'GRAMS',value:1250}},unitCost:{amount:'60.00',currencyCode:'EUR'}},
    product:{id:'gid://shopify/Product/1',title:'Luxury bed '+(i+1),vendor:'MiaCara',status:'ACTIVE'},
    levels:[{locationId:locationId(1),active:true,available:3,committed:2,onHand:5},{locationId:locationId(2),active:true,available:5,committed:0,onHand:5}]}));
  const calls=[],writes=[],keys=new Set(),controls={},deleted=new Set(),deletions=new Map();
  const total=v=>v.levels.filter(l=>l.active).reduce((n,l)=>n+l.available,0);
  function view(v){return {...structuredClone(v),inventoryQuantity:total(v)};}
  const api=async(query,vars={})=>{
    calls.push({query,vars:structuredClone(vars)});
    if(query.includes('ShopInfo'))return {shop:{name:'Inventory test',myshopifyDomain:'example.myshopify.com',currencyCode:'EUR'}};
    if(query.includes('PricingVariants'))return {productVariants:{nodes:variants.filter(v=>!deleted.has(v.product.id)).map(view),pageInfo:info}};
    if(query.includes('PricingCollections'))return {collections:{nodes:[],pageInfo:info}};
    if(query.includes('PricingMemberships'))return {nodes:vars.ids.map(id=>({id,collections:{nodes:[],pageInfo:info}}))};
    if(query.includes('ProductDeleteDetails')){
      const group=variants.filter(v=>v.product.id===vars.id);
      return {product:group.length&&(!deleted.has(vars.id)||controls.keepDeletedProduct)?{id:vars.id,title:group[0].product.title,updatedAt:controls.productUpdatedAt??'2026-10-23T10:00:00Z',variantsCount:{count:group.length,precision:'EXACT'}}:null};
    }
    if(query.includes('DeleteCatalogProduct')){
      writes.push({query,vars:structuredClone(vars)});
      if(controls.deleteDenied)return{productDelete:{productDeleteOperation:null,userErrors:[{message:'Delete permission denied'}]}};
      const id='gid://shopify/ProductDeleteOperation/'+(deletions.size+1);deletions.set(id,{productId:vars.input.id,polls:0});
      if(controls.deleteNetwork)throw new Error('Delete network timeout');
      return {productDelete:{productDeleteOperation:{id},userErrors:[]}};
    }
    if(query.includes('ProductDeletionStatus')){
      if(controls.deleteWait)await controls.deleteWait;
      const op=deletions.get(vars.id);op.polls++;
      if(op.polls<=(controls.deletePendingPolls??0))return{productOperation:{id:vars.id,status:'ACTIVE',deletedProductId:null,userErrors:[]}};
      const errors=controls.deleteErrors??[];if(!errors.length)deleted.add(op.productId);
      return {productOperation:{id:vars.id,status:'COMPLETE',deletedProductId:controls.wrongDeletedId??op.productId,userErrors:errors}};
    }
    if(query.includes('ProductEditLocations')){
      const i=vars.after?Number(vars.after):0;return {locations:{nodes:locations.slice(i,i+2),pageInfo:{hasNextPage:i+2<locations.length,endCursor:String(i+2)}}};
    }
    if(query.includes('ProductEditVariant')){const v=variants.find(v=>v.id===vars.id);if(controls.onRead)controls.onRead(v,writes.length);return {productVariant:v?view(v):null};}
    if(query.includes('ProductEditLevels')){
      const v=variants.find(v=>v.inventoryItem.id===vars.id),i=vars.after?Number(vars.after):0;
      return {inventoryItem:{id:v.inventoryItem.id,inventoryLevels:{nodes:v.levels.slice(i,i+1).map(l=>({id:'level-'+v.id+'-'+l.locationId,isActive:l.active,location:{id:l.locationId,name:locations.find(x=>x.id===l.locationId).name},quantities:[{name:'available',quantity:l.available},{name:'committed',quantity:l.committed},{name:'on_hand',quantity:l.onHand}]})),pageInfo:{hasNextPage:i+1<v.levels.length,endCursor:String(i+1)}}}};
    }
    const v=variants.find(v=>v.inventoryItem.id===(vars.id??vars.inventoryItemId??vars.input?.quantities?.[0]?.inventoryItemId))??variants.find(v=>v.id===vars.variants?.[0]?.id);
    writes.push({query,vars:structuredClone(vars)});
    if(controls.wait)await controls.wait;
    if(controls.denyAt===writes.length)return {[query.includes('ProductEditItem')?'inventoryItemUpdate':query.includes('ProductEditPolicy')?'productVariantsBulkUpdate':query.includes('ProductEditActivate')?'inventoryActivate':'inventorySetQuantities']:{userErrors:[{message:'Denied mutation'}]}};
    if(query.includes('ProductEditItem')){
      if('tracked'in vars.input)v.inventoryItem.tracked=vars.input.tracked;
      if(vars.input.measurement)v.inventoryItem.measurement.weight=structuredClone(vars.input.measurement.weight);
      return {inventoryItemUpdate:{inventoryItem:{id:v.inventoryItem.id},userErrors:[]}};
    }
    if(query.includes('ProductEditPolicy')){v.inventoryPolicy=vars.variants[0].inventoryPolicy;return {productVariantsBulkUpdate:{productVariants:[{id:v.id,inventoryPolicy:v.inventoryPolicy}],userErrors:[]}};}
    if(query.includes('ProductEditActivate')){
      if(keys.has(vars.key))throw new Error('Duplicate key');keys.add(vars.key);
      let l=v.levels.find(l=>l.locationId===vars.locationId);if(l)l.active=true;else v.levels.push({locationId:vars.locationId,active:true,available:0,onHand:0,committed:0});
      return {inventoryActivate:{inventoryLevel:{id:'activated'},userErrors:[]}};
    }
    if(query.includes('ProductEditQuantities')){
      if(keys.has(vars.key))throw new Error('Duplicate key');keys.add(vars.key);
      const q=vars.input.quantities[0],l=v.levels.find(l=>l.locationId===q.locationId);
      if(controls.beforeSet)controls.beforeSet(v,l);
      if(l.available!==q.changeFromQuantity)return {inventorySetQuantities:{userErrors:[{message:'Compare and swap mismatch'}]}};
      l.onHand+=q.quantity-l.available;l.available=q.quantity;
      if(controls.networkAt===writes.length)throw new Error('Network timeout');
      return {inventorySetQuantities:{inventoryAdjustmentGroup:{reason:'correction'},userErrors:[]}};
    }
    throw new Error('Unexpected query');
  };
  const app=createApplication(config,{makeShopify:()=>api,deletePause:async()=>{}});
  app.store.saveSettings({shop:'example.myshopify.com',mode:'access_token',accessToken:'mock'});
  for(const v of variants)app.store.db.prepare('INSERT INTO variants VALUES (?,?)').run(v.id,JSON.stringify({id:v.id,productId:v.product.id,title:v.product.title,variant:v.title,vendor:v.product.vendor,status:v.product.status,sku:v.inventoryItem.sku,price:10000,cost:6000,currency:'EUR',taxable:true,compareAt:null,collectionIds:[],...inventoryFields(view(v))}));
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));t?.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;let cookie='',csrf='';
  async function request(path,input,headers={}){const response=await fetch(base+'/api/'+path,{method:input===undefined?'GET':'POST',headers:{Origin:config.appUrl,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},body:input===undefined?undefined:JSON.stringify(input)});if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:await response.json()};}
  await request('login',{password:config.password});csrf=(await request('state')).data.csrf;
  async function idle(){for(let i=0;i<1000;i++){const state=(await request('state')).data;if(!state.job.running)return state;await new Promise(r=>setTimeout(r,2));}throw new Error('Timed out');}
  async function save(field,data,ids=variants.map(v=>v.id),extra={}){const r=await request('product-edit/save',{requestId:randomUUID(),field,data,ids,...extra});if(r.status!==200)throw new Error(r.data.error);return idle();}
  return {app,config,base,request,idle,save,variants,locations,calls,writes,controls,deleted,deletions};
}
