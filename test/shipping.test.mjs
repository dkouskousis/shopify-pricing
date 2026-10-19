import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createApplication } from '../server.mjs';
import { openStore } from '../store.mjs';
import { adjustedShippingPrice, shippingRates, shippingUpdate } from '../shipping.mjs';
import { createDhl, validateDhlSettings, validateShipment } from '../dhl.mjs';
const pageInfo = { hasNextPage:false, endCursor:null };
const id = (type,n) => `gid://shopify/${type}/${n}`;
const country = {name:'Germany',code:{countryCode:'DE',restOfWorld:false}};
const method = (n,price='10.00',currency='EUR') => ({ id:id('DeliveryMethodDefinition',n), name:'DHL Express '+n, active:true,description:'Express',
  methodConditions:[{id:id('DeliveryCondition',n),field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:2,unit:'KILOGRAMS'}}],
  rateProvider:{__typename:'DeliveryRateDefinition',id:id('DeliveryRateDefinition',n),price:{amount:price,currencyCode:currency}} });
const dhl = {environment:'live',username:'my-api-user',password:'my-secret-pass',accountNumber:'123456789',originCountryCode:'GR',originPostalCode:'10557',originCityName:'Athens'};
const sample = {destinationCountryCode:'DE',destinationPostalCode:'10115',destinationCityName:'Berlin',weight:'2',length:'30',width:'20',height:'10',plannedShippingDate:new Date(Date.now()+86400000).toISOString().slice(0,10),isCustomsDeclarable:false};
const config={appUrl:'http://localhost',password:'test-password-shipping-only',encryptionKey:'ac'.repeat(32),dbPath:':memory:'};
async function harness(t) {
  const methods=[method(1),method(2,'20.00'),method(3,'0.00'),{...method(4),rateProvider:{__typename:'DeliveryParticipant',id:id('DeliveryParticipant',4)}}];
  let writes=[],failWrite='',readError=false,quoteError=false,quoteWait=null;
  const api=async(q,v)=>{
    if(q.includes('ShippingProfiles'))return {deliveryProfiles:{nodes:[{id:id('DeliveryProfile',1),name:'General',profileLocationGroups:[{locationGroup:{id:id('DeliveryLocationGroup',1)}}]}],pageInfo}};
    if(q.includes('ShippingZone')){if(readError)throw new Error('Shipping read failure');return {deliveryProfile:{id:v.id,name:'General',profileLocationGroups:[{locationGroup:{id:v.group},locationGroupZones:{edges:[{cursor:'zone1',node:{zone:{id:id('DeliveryZone',1),name:'EU',countries:[country]},methodDefinitions:{nodes:structuredClone(methods),pageInfo}}}],pageInfo}}]}};}
    if(q.includes('UpdateShippingPrice')){writes.push(structuredClone(v));if(failWrite==='network')throw new Error('Timeout during write');if(failWrite==='denied')return {deliveryProfileUpdate:{profile:null,userErrors:[{message:'Missing write_shipping permission'}]}};
      const input=v.profile.locationGroupsToUpdate[0].zonesToUpdate[0].methodDefinitionsToUpdate[0];methods.find(m=>m.id===input.id).rateProvider.price.amount=input.rateDefinition.price.amount;
      return {deliveryProfileUpdate:{profile:{id:v.id},userErrors:[]}};
    }
    throw new Error('Unexpected query');
  };
  const app=createApplication(config,{makeShopify:()=>api,makeDhl:s=>async input=>{if(quoteWait)await quoteWait;if(quoteError)throw new Error('Oops '+s.password);return {products:[{code:'P',name:'EXPRESS WORLDWIDE',price:1850,currency:'EUR'}],sample:input,environment:s.environment,at:new Date().toISOString()};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  let cookie='',csrf='';const base='http://127.0.0.1:'+app.server.address().port;
  async function request(path,input,headers={}){const r=await fetch(base+'/api/'+path,{method:input===undefined?'GET':'POST',headers:{Origin:config.appUrl,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},body:input===undefined?undefined:JSON.stringify(input)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
  async function idle(){for(let i=0;i<100;i++){const s=(await request('state')).data;if(!s.job.running)return s;await setTimeout(5);}throw new Error('Timeout');}
  await request('login',{password:config.password});csrf=(await request('state')).data.csrf;
  app.store.saveSettings({shop:'example.myshopify.com',mode:'access_token',accessToken:'mock'});
  await request('shipping/sync',{});const s=await idle();assert.equal(s.job.error,null);
  return {app,request,idle,methods,writes,rows:s.shipping.rows,setWriteFailure:v=>{failWrite=v;},setReadError:()=>{readError=true;},setQuoteError:()=>{quoteError=true;},setQuoteWait:v=>{quoteWait=v;}};
}
test('shipping adjustment accepts signed fixed/percentage values, preserves exact cents and rejects invalid amounts',()=>{
  assert.equal(adjustedShippingPrice(1000,'fixed','+2'),1200);assert.equal(adjustedShippingPrice(1200,'percent','-10'),1080);
  assert.equal(adjustedShippingPrice(1995,'percent','10'),2195);assert.equal(adjustedShippingPrice(1000,'fixed','-1,25'),875);
  for(const[k,v]of [['fixed','-11'],['percent','-101'],['x','2'],['fixed','abc'],['fixed','1.234']])assert.throws(()=>adjustedShippingPrice(1000,k,v));
});
test('shipping preview applies all selected tiers only, preserves conditions, verifies readback and cannot replay',async t=>{
 const h=await harness(t),ids=h.rows.slice(0,2).map(r=>r.id);
 assert.equal(h.rows[3].editable,false);
 const p=await h.request('shipping/preview',{ids,base:'current',kind:'fixed',value:'2'});assert.equal(p.status,200);assert.deepEqual(p.data.items.map(i=>i.newPrice),[1200,2200]);assert.equal(h.writes.length,0);
 assert.equal((await h.request('shipping/apply',{id:p.data.id})).status,200);const state=await h.idle();assert.equal(h.writes.length,2);assert.deepEqual(state.shipping.rows.slice(0,3).map(r=>r.price),[1200,2200,0]);
 assert.equal(state.audit[0].kind,'shipping');assert.equal(state.audit[0].status,'success');assert.equal(state.audit[0].sku,'');
 const input=h.writes[0].profile.locationGroupsToUpdate[0].zonesToUpdate[0].methodDefinitionsToUpdate[0];assert.deepEqual(Object.keys(input),['id','rateDefinition']);assert.equal(input.rateDefinition.price.amount,'12.00');
 assert.equal((await h.request('shipping/apply',{id:p.data.id})).status,400);
 const minus=await h.request('shipping/preview',{ids,base:'current',kind:'percent',value:'-10'});assert.deepEqual(minus.data.items.map(i=>i.newPrice),[1080,1980]);
});
test('free rates and carrier-calculated rates are protected; invalid selection and CSRF cannot mutate',async t=>{
 const h=await harness(t),p={base:'current',kind:'fixed',value:'2'};
 assert.equal((await h.request('shipping/preview',{...p,ids:[h.rows[2].id]})).status,400);
 assert.equal((await h.request('shipping/preview',{...p,ids:[h.rows[3].id],includeFree:true})).status,400);
 assert.equal((await h.request('shipping/preview',{...p,ids:[h.rows[0].id,h.rows[0].id]})).status,400);
 assert.equal((await h.request('shipping/preview',{...p,ids:[h.rows[0].id]}, {'X-CSRF-Token':''})).status,403);
 assert.equal((await h.request('shipping/preview',{...p,ids:[h.rows[2].id],includeFree:true})).data.items[0].newPrice,200);assert.equal(h.writes.length,0);
});
test('stale shipping prices or condition changes reject before mutation; failed sync preserves cache',async t=>{
 const h=await harness(t),body={ids:[h.rows[0].id],base:'current',kind:'fixed',value:'2'};
 const p=(await h.request('shipping/preview',body)).data;h.methods[0].methodConditions[0].conditionCriteria.value=3;
 await h.request('shipping/apply',{id:p.id});let s=await h.idle();assert.equal(h.writes.length,0);assert.equal(s.audit[0].status,'failed');
 const before=s.shipping;h.setReadError();await h.request('shipping/sync',{});s=await h.idle();assert.deepEqual(s.shipping,before);assert.match(s.job.error,/Shipping read failure/);
});
test('uncertain shipping writes never silently succeed or retry',async t=>{
 const h=await harness(t);const p=(await h.request('shipping/preview',{ids:[h.rows[0].id],base:'current',kind:'fixed',value:'2'})).data;
 h.setWriteFailure('network');await h.request('shipping/apply',{id:p.id});const s=await h.idle();assert.equal(h.writes.length,1);assert.equal(s.audit[0].status,'uncertain');assert.equal(s.shipping.rows[0].price,1000);
 assert.equal((await h.request('shipping/apply',{id:p.id})).status,400);
});
test('DHL settings are encrypted, passwords masked, sample and chosen service drive quote-based previews',async t=>{
 const h=await harness(t),row=h.rows[0];assert.equal((await h.request('dhl/settings',dhl)).status,200);
 let s=(await h.request('state')).data;assert.equal(s.shipping.dhl.hasPassword,true);assert.ok(!JSON.stringify(s).includes(dhl.password));assert.ok(!JSON.stringify(h.app.store.get('dhlSettings')).includes(dhl.password));
 assert.equal((await h.request('shipping/quote',{id:row.id})).status,400);
 assert.equal((await h.request('shipping/sample',{id:row.id,sample:{...sample,destinationCountryCode:'FR'}})).status,400);
 assert.equal((await h.request('shipping/sample',{id:row.id,sample})).status,200);assert.equal((await h.request('shipping/quote',{id:row.id})).status,200);
 const body={ids:[row.id],base:'dhl',kind:'fixed',value:'2',serviceCode:'P'};let p=(await h.request('shipping/preview',body)).data;assert.equal(p.items[0].newPrice,2050);
 assert.equal((await h.request('shipping/preview',{...body,serviceCode:'X'})).status,400);
 await h.request('dhl/settings',{...dhl,password:'',environment:'test'});assert.equal(h.app.store.decrypt(h.app.store.get('dhlSettings')).password,dhl.password);
 assert.equal((await h.request('shipping/preview',body)).status,400);await h.request('shipping/quote',{id:row.id});assert.equal((await h.request('shipping/preview',body)).status,400);
 h.setQuoteError();const error=await h.request('shipping/quote',{id:row.id});assert.ok(!JSON.stringify(error).includes(dhl.password));assert.match(error.data.error,/hidden/);
});
test('DHL requests use fixed official endpoint, Basic Auth and billing EUR, never public tariff fallback',async()=>{
 const calls=[];const api=createDhl(dhl,async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({products:[{productCode:'P',productName:'EXPRESS',totalPrice:[{currencyType:'PULCL',priceCurrency:'EUR',price:99},{currencyType:'BILLC',priceCurrency:'EUR',price:18.5}]}]})};});
 const q=await api(sample);assert.equal(q.products[0].price,1850);const url=new URL(calls[0].url);assert.equal(url.origin,'https://express.api.dhl.com');assert.equal(url.pathname,'/mydhlapi/rates');assert.equal(url.searchParams.get('unitOfMeasurement'),'metric');assert.equal(url.searchParams.get('isCustomsDeclarable'),'false');assert.equal(calls[0].options.headers.Authorization,'Basic '+Buffer.from(dhl.username+':'+dhl.password).toString('base64'));
 await assert.rejects(createDhl(dhl,async()=>({ok:true,json:async()=>({products:[{productCode:'P',productName:'EXPRESS',totalPrice:[{currencyType:'PULCL',priceCurrency:'EUR',price:99}]}]})}))(sample),/EUR billing/);
 assert.throws(()=>validateDhlSettings({...dhl,environment:'arbitrary'}));assert.throws(()=>validateShipment({...sample,weight:0}));assert.throws(()=>validateShipment({...sample,plannedShippingDate:'2020-02-31'}));
});
test('shipping pagination follows later profiles, zones and methods, rejecting repeated cursors',async()=>{
 let calls=0;const api=async(q,v)=>{calls++;if(q.includes('ShippingProfiles'))return {deliveryProfiles:{nodes:[{id:id('DeliveryProfile',v.after?2:1),name:'P',profileLocationGroups:[{locationGroup:{id:'group'}}]}],pageInfo:{hasNextPage:!v.after,endCursor:'profile2'}}};
 const zone=v.after?'z2':'z1';return{deliveryProfile:{profileLocationGroups:[{locationGroup:{id:'group'},locationGroupZones:{edges:[{cursor:zone,node:{zone:{id:zone,name:zone,countries:[country]},methodDefinitions:{nodes:[method(v.methodsAfter?2:1)],pageInfo:{hasNextPage:!v.methodsAfter,endCursor:'method2'}}}}],pageInfo:{hasNextPage:!v.after,endCursor:'z2'}}}]}};};
 const rows=await shippingRates(api);assert.equal(rows.length,8);assert.equal(calls,10);
 await assert.rejects(shippingRates(async()=>({deliveryProfiles:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'repeated'}}})),/σελιδοποίηση/);
});
test('audit retains exactly 2000 records with SKU snapshots independent of later product edits',()=>{
 const store=openStore(':memory:',config.encryptionKey),db=store.db;
 db.prepare('INSERT INTO variants VALUES (?,?)').run('v',JSON.stringify({sku:'ORIGINAL'}));const insert=db.prepare("INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail) VALUES ('now','v','title',1,2,'success','')");
 for(let i=0;i<2005;i++)insert.run();assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n,2000);
 db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({sku:'NEW'}),'v');insert.run();const rows=db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 2').all();assert.equal(rows[0].sku,'NEW');assert.equal(rows[1].sku,'ORIGINAL');db.close();
});
test('DHL sample rejects a parcel outside the selected weight tier',async t=>{
 const h=await harness(t);const result=await h.request('shipping/sample',{id:h.rows[0].id,sample:{...sample,weight:3}});assert.equal(result.status,400);assert.match(result.data.error,/βάρoς|βάρος/);
});
test('in-flight DHL requests block concurrent Shopify writes and credential edits',async t=>{
 const h=await harness(t);await h.request('dhl/settings',dhl);await h.request('shipping/sample',{id:h.rows[0].id,sample});
 let release;h.setQuoteWait(new Promise(resolve=>{release=resolve;}));const pending=h.request('shipping/quote',{id:h.rows[0].id});
 let state;for(let i=0;i<50;i++){state=(await h.request('state')).data;if(state.job.priceSaving)break;await setTimeout(2);}assert.equal(state.job.priceSaving,true);
 assert.equal((await h.request('dhl/settings',dhl)).status,409);assert.equal((await h.request('shipping/sync',{})).status,409);release();assert.equal((await pending).status,200);
});
test('bulk sample autofill saves only selected tiers with their own maximum weight and preserves customs choice',async t=>{
 const h=await harness(t);const rows=structuredClone(h.rows);rows[1].conditions[0].conditionCriteria.value=5;h.app.store.put('shippingRates',rows);
 await h.request('shipping/sample',{id:rows[0].id,sample:{...sample,isCustomsDeclarable:true}});
 const result=await h.request('shipping/samples/autofill',{ids:rows.slice(0,2).map(r=>r.id)});assert.equal(result.status,200);assert.equal(result.data.saved.length,2);assert.deepEqual(result.data.skipped,[]);
 const s=(await h.request('state')).data;assert.equal(s.shipping.rows[0].sample.weight,2);assert.equal(s.shipping.rows[1].sample.weight,5);
 assert.equal(s.shipping.rows[0].sample.isCustomsDeclarable,true);assert.equal(s.shipping.rows[1].sample.isCustomsDeclarable,false);
 for(const row of s.shipping.rows.slice(0,2)){assert.equal(row.sample.destinationPostalCode,'10115');assert.equal(row.sample.destinationCityName,'Berlin');assert.equal(row.sample.length,10);assert.equal(row.sample.width,10);assert.equal(row.sample.height,10);}
 assert.equal(s.shipping.rows[2].sample,null);assert.equal(h.writes.length,0);
});
test('bulk autofill skips incomplete tiers and preserves their previous samples while filling the rest',async t=>{
 const h=await harness(t);await h.request('shipping/sample',{id:h.rows[0].id,sample});const old=h.app.store.get('shippingSamples')[h.rows[0].id];
 const rows=structuredClone(h.rows);rows[0].conditions=[];rows[1].countries=[{name:'Afghanistan',code:{countryCode:'AF',restOfWorld:false}}];h.app.store.put('shippingRates',rows);
 const r=await h.request('shipping/samples/autofill',{ids:rows.slice(0,3).map(r=>r.id)});assert.equal(r.status,200);assert.deepEqual(r.data.saved,[rows[2].id]);assert.equal(r.data.skipped.length,2);
 assert.deepEqual(h.app.store.get('shippingSamples')[rows[0].id],old);assert.equal(h.app.store.get('shippingSamples')[rows[1].id],undefined);
});
test('bulk autofill invalidates quotes only for updated samples and invalidates shipping previews',async t=>{
 const h=await harness(t);await h.request('dhl/settings',dhl);
 for(const row of h.rows.slice(0,2)){await h.request('shipping/sample',{id:row.id,sample});await h.request('shipping/quote',{id:row.id});}
 const p=(await h.request('shipping/preview',{ids:[h.rows[0].id],base:'current',kind:'fixed',value:'2'})).data;
 await h.request('shipping/samples/autofill',{ids:[h.rows[0].id]});const s=(await h.request('state')).data;
 assert.equal(s.shipping.rows[0].quote,null);assert.ok(s.shipping.rows[1].quote);assert.equal((await h.request('shipping/apply',{id:p.id})).status,400);
});
test('bulk sample autofill rejects malformed selections and CSRF before changing samples',async t=>{
 const h=await harness(t);const path='shipping/samples/autofill';
 for(const ids of [[],[h.rows[0].id,h.rows[0].id],['missing'],Array.from({length:2001},(_,i)=>String(i))])assert.equal((await h.request(path,{ids})).status,400);
 assert.equal((await h.request(path,{ids:[h.rows[0].id]},{'X-CSRF-Token':''})).status,403);assert.equal(h.app.store.get('shippingSamples'),null);
});
test('bulk sample autofill handles 2000 tiers in one local save without Shopify writes',async t=>{
 const h=await harness(t);const rows=Array.from({length:2000},(_,i)=>({...h.rows[0],id:'tier-'+i}));h.app.store.put('shippingRates',rows);
 const r=await h.request('shipping/samples/autofill',{ids:rows.map(r=>r.id)});assert.equal(r.status,200);assert.equal(r.data.saved.length,2000);assert.equal(Object.keys(h.app.store.get('shippingSamples')).length,2000);assert.equal(h.writes.length,0);
});

test('country directory save requires CSRF, persists into state and rejects malformed entries',async t=>{
 const h=await harness(t),path='shipping/countries/save',entry={code:'BD',city:'Dhaka',postalCode:'1205',noPostalCode:false};
 assert.equal((await h.request(path,entry,{'X-CSRF-Token':''})).status,403);
 assert.equal((await h.request(path,{...entry,postalCode:''})).status,400);
 assert.equal((await h.request(path,entry)).status,200);
 const directory=(await h.request('state')).data.shipping.directory;assert.equal(directory.BD.postalCode,'1205');assert.ok(Object.keys(directory).length>=249);
 assert.equal((await h.request('shipping/countries/refresh',{codes:['XX']})).status,400);assert.equal(h.writes.length,0);
});
