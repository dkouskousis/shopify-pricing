import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingRates, shippingUpdate, shippingFingerprint, SHIPPING_QUERIES } from '../shipping.mjs';
import { createShippingService } from '../shipping-service.mjs';
import { createShopify } from '../shopify.mjs';
import { openStore } from '../store.mjs';
const pageInfo={hasNextPage:false,endCursor:null};
function fixture() {
 const ranges = (min,max) => [{subject:'PACKAGE_WEIGHT',min:{value:min,unit:'KILOGRAMS'},max:max===null?null:{value:max,unit:'KILOGRAMS'}}];
 const providers=[{__typename:'DeliveryRateDefinition',id:'rate1',price:{amount:'10.00',currencyCode:'EUR'},conditions:ranges(0,2),minTransitTime:1,maxTransitTime:3},
  {__typename:'DeliveryRateDefinition',id:'rate2',price:{amount:'20.00',currencyCode:'EUR'},conditions:ranges(2.001,5),minTransitTime:2,maxTransitTime:4},
  {__typename:'DeliveryRateDefinition',id:'rate3',price:{amount:'30.00',currencyCode:'EUR'},conditions:ranges(5.001,null),minTransitTime:null,maxTransitTime:null}];
 const method={id:'method1',name:'DHL',active:true,description:'Express',currencyCode:'EUR',freeConditions:[{subject:'TOTAL_CART_VALUE',min:{amount:'200.00',currencyCode:'EUR'},max:null}]};
 const writes=[],versions=[];let repeated=false,extraGroup=false,providerReads=0,alterAfterWrite=false;
 const api=async(q,v,version)=>{
  versions.push(version);
  if(q===SHIPPING_QUERIES.profiles)return {deliveryProfiles:{nodes:[{id:'profile1',name:'General',profileLocationGroups:[{locationGroup:{id:'location1'}}]}],pageInfo}};
  if(q===SHIPPING_QUERIES.zone)return {deliveryProfile:{id:'profile1',profileLocationGroups:[{locationGroup:{id:'location1'},locationGroupZones:{edges:[{cursor:'z1',node:{zone:{id:'zone1',name:'EU',countries:[{name:'Germany',code:{countryCode:'DE',restOfWorld:false}}]},methodDefinitions:{nodes:[structuredClone(method)],pageInfo}}}],pageInfo}}]}};
  if(q===SHIPPING_QUERIES.providers){providerReads++;return {node:{id:'method1',rateGroups:{nodes:[{id:'group1',rateProviders:{nodes:structuredClone(providers.slice(v.after?1:0,v.after?3:1)),pageInfo:{hasNextPage:repeated||!v.after,endCursor:'page2'}}},...(extraGroup?[{id:'group2'}]:[])],pageInfo}}};}
  if(q===SHIPPING_QUERIES.update){
   writes.push(structuredClone(v));const input=v.profile.locationGroupsToUpdate[0].zonesToUpdate[0].methodDefinitionsToUpdate[0];
   assert.equal(input.id,'method1');assert.equal(Object.hasOwn(input,'rateDefinition'),false);assert.deepEqual(Object.keys(input),['id','rateGroupsToUpdate']);
   assert.equal(input.rateGroupsToUpdate[0].id,'group1');const rate=input.rateGroupsToUpdate[0].rateDefinitionsToUpdate[0];assert.deepEqual(Object.keys(rate),['id','price']);providers.find(p=>p.id===rate.id).price=rate.price;
   if(alterAfterWrite)providers[1].conditions[0].max.value=6;
   return {deliveryProfileUpdate:{profile:{id:'profile1'},userErrors:[]}};
  }
  throw new Error('Unexpected operation');
 };
 return {api,providers,method,writes,versions,setRepeated:()=>{repeated=true;},extraGroup:()=>{extraGroup=true;},alterAfterWrite:()=>{alterAfterWrite=true;},reads:()=>providerReads};
}
function service(t,f) {
 const store=openStore(':memory:','cd'.repeat(32));t.after(()=>store.db.close());let work;const job={completed:0};
 const s=createShippingService({store,graphql:()=>f.api,startJob:(type,w)=>{work=w;},jobState:()=>job,safeError:e=>e.message,stopping:()=>false});
 return {s,store,run:()=>work()};
}
test('new API reads every tier with unique identity, exact limits and an explicit readonly free-shipping rule',async()=>{
 const f=fixture(),rows=await shippingRates(f.api);assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.id)).size,4);assert.equal(f.reads(),2);
 assert.deepEqual(rows.slice(0,3).map(r=>r.price),[1000,2000,3000]);assert.equal(rows[1].rateGroupId,'group1');assert.equal(rows[1].conditions[0].conditionCriteria.value,2.001);assert.equal(rows[1].conditions[1].conditionCriteria.value,5);
 assert.equal(rows[3].editable,false);assert.equal(rows[3].type,'FreeCondition');assert.equal(rows[3].conditions[0].conditionCriteria.amount,'200.00');
 assert.throws(()=>shippingUpdate(rows[3],100));
});
test('manual grouped save updates only the chosen tier and preserves siblings, transit times, free threshold and sample migration',async t=>{
 const f=fixture(),h=service(t,f);h.store.put('shippingRates',[{id:'legacy',profileId:'profile1',groupId:'location1',zoneId:'zone1',providerId:'rate2',editable:true}]);h.store.put('shippingSamples',{legacy:{weight:5,length:10}});
 assert.equal(h.s.state().needsSync,true);assert.equal(h.s.state().rows[0].editable,false);
 await h.s.handle('/api/shipping/sync',{});await h.run();const rows=h.s.state().rows;assert.equal(h.s.state().needsSync,false);assert.deepEqual(rows[1].sample,{weight:5,length:10});
 const before=structuredClone(f.providers),free=structuredClone(f.method.freeConditions);await h.s.handle('/api/shipping/price',{id:rows[1].id,price:'24.95',expectedFingerprint:rows[1].fingerprint});
 assert.equal(f.writes.length,1);assert.equal(f.providers[1].price.amount,'24.95');assert.deepEqual(f.providers[0],before[0]);assert.deepEqual(f.providers[2],before[2]);assert.deepEqual(f.providers[1].conditions,before[1].conditions);assert.deepEqual(f.method.freeConditions,free);assert.equal(f.providers[1].maxTransitTime,4);
 assert.equal(h.s.state().rows[1].price,2495);assert.equal(h.store.db.prepare('SELECT status FROM audit').get().status,'success');assert.ok(f.versions.every(v=>v==='unstable'));
});
test('bulk grouped save targets two tiers in one option without overwriting other tiers or the free rule',async t=>{
 const f=fixture(),h=service(t,f);await h.s.handle('/api/shipping/sync',{});await h.run();const rows=h.s.state().rows;
 const plan=await h.s.handle('/api/shipping/preview',{ids:rows.slice(0,2).map(r=>r.id),base:'current',kind:'fixed',value:'2'});await h.s.handle('/api/shipping/apply',{id:plan.id});await h.run();
 assert.deepEqual(f.providers.map(p=>p.price.amount),['12.00','22.00','30.00']);assert.equal(f.writes.length,2);assert.equal(h.s.state().rows[3].price,0);
});
test('new API pagination detects repeated cursors and refuses unsupported extra groups without truncation',async()=>{
 const f=fixture();f.setRepeated();await assert.rejects(shippingRates(f.api),/σελιδοποίηση/);
 const second=fixture();second.extraGroup();await assert.rejects(shippingRates(second.api),/δομή/);
});
test('free-threshold changes are detected before writing; altered tier readback is uncertain',async t=>{
 const f=fixture(),h=service(t,f);await h.s.handle('/api/shipping/sync',{});await h.run();let row=h.s.state().rows[1];
 f.method.freeConditions[0].min.amount='250.00';await assert.rejects(h.s.handle('/api/shipping/price',{id:row.id,price:'25',expectedFingerprint:row.fingerprint}),/άλλαξε/);assert.equal(f.writes.length,0);
 await h.s.handle('/api/shipping/sync',{});await h.run();row=h.s.state().rows[1];f.alterAfterWrite();await assert.rejects(h.s.handle('/api/shipping/price',{id:row.id,price:'25',expectedFingerprint:row.fingerprint}),/επιβεβαιώθηκε/);
 assert.equal(h.store.db.prepare('SELECT status FROM audit ORDER BY id DESC LIMIT 1').get().status,'uncertain');
});
test('Shopify client routes grouped shipping explicitly to unstable while products remain on the configured stable API',async()=>{
 const urls=[];const api=createShopify({shop:'test.myshopify.com',mode:'access_token',accessToken:'fake'},async url=>{urls.push(url);return new Response(JSON.stringify({data:{ok:true}}));});
 await api('query Product {shop{name}}');await api(SHIPPING_QUERIES.profiles,{},'unstable');assert.match(urls[0],/2026-10/);assert.match(urls[1],/unstable/);await assert.rejects(api('query {shop{name}}',{},'invented'));
});
