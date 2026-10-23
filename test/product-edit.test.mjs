import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {productHarness,locationId,variantId} from './helpers/product-edit-fixture.mjs';
import {changedWeight} from '../product-edit.mjs';
const inventory=(quantities=[],tracked=null,policy=null)=>({tracked,policy,quantities});
const quantity=(location,value,mode='set')=>({locationId:locationId(location),mode,value});
test('sync reads inventory flags, total stock and converts original weight to kilograms',async t=>{
 const h=await productHarness(t);assert.equal((await h.request('sync',{})).status,202);const s=await h.idle();assert.equal(s.job.error,null);assert.equal(s.products[0].inventoryQuantity,8);assert.equal(s.products[0].weightKg,1.25);assert.equal(s.products[0].tracked,true);
});
test('direct inventory save includes every warehouse and writes CAS-protected available quantities while preserving committed stock',async t=>{
 const h=await productHarness(t);const details=(await h.request('product-edit/details',{id:variantId(1),field:'inventory'})).data;assert.equal(details.locations.length,4);assert.equal(details.snapshot.levels.length,2);assert.equal(h.writes.length,0);
 const s=await h.save('inventory',inventory([quantity(1,'10'),quantity(2,'4')],true,'CONTINUE'),[variantId(1)],{expected:details.fingerprints.inventory});assert.equal(s.audit[0].status,'success');assert.equal(s.audit[0].kind,'inventory');assert.match(s.audit[0].new_text,/Athens: 10/);assert.equal(s.products[0].inventoryQuantity,14);assert.equal(s.products[0].inventoryPolicy,'CONTINUE');assert.equal(h.variants[0].levels[0].committed,2);assert.equal(h.variants[0].price,'100.00');
 const sets=h.writes.filter(w=>w.query.includes('ProductEditQuantities'));assert.deepEqual(sets.map(w=>w.vars.input.quantities[0].changeFromQuantity),[3,5]);assert.ok(sets.every(w=>w.vars.input.name==='available'&&w.vars.key));
});
test('new warehouse activation is followed by zero-based CAS without changing other locations',async t=>{
 const h=await productHarness(t);const s=await h.save('inventory',inventory([quantity(3,'2')]),[variantId(1)]);assert.equal(s.audit[0].status,'success');assert.equal(s.products[0].inventoryQuantity,10);
 const activate=h.writes.find(w=>w.query.includes('ProductEditActivate'));assert.deepEqual(Object.keys(activate.vars).sort(),['inventoryItemId','key','locationId']);assert.equal(h.writes.find(w=>w.query.includes('ProductEditQuantities')).vars.input.quantities[0].changeFromQuantity,0);assert.deepEqual(h.variants[0].levels.slice(0,2).map(l=>l.available),[3,5]);
});
test('tracking and backorder save directly and untracked quantity errors are recorded per item',async t=>{
 const h=await productHarness(t);h.variants[0].inventoryItem.tracked=false;
 let s=await h.save('inventory',inventory([quantity(1,'4')]),[variantId(1)]);assert.match(s.audit[0].detail,/παρακολούθηση/);assert.equal(h.writes.length,0);
 s=await h.save('inventory',inventory([quantity(1,'4')],true,'CONTINUE'),[variantId(1)]);assert.equal(s.audit[0].status,'success');assert.equal(s.products[0].tracked,true);assert.equal(s.products[0].inventoryQuantity,9);
 s=await h.save('inventory',inventory([],false,'DENY'),[variantId(1)]);assert.equal(s.products[0].tracked,false);assert.equal(s.products[0].inventoryPolicy,'DENY');assert.equal(h.variants[0].levels[0].available,4);
});
test('weight edits avoid locations and level queries and save directly with one fresh read plus readback',async t=>{
 const h=await productHarness(t);await h.request('product-edit/details',{id:variantId(1),field:'weight'});assert.equal(h.calls.length,1);assert.ok(h.calls[0].query.includes('ProductEditVariant'));
 h.calls.length=0;let s=await h.save('weight',{mode:'set',value:'2,345678'});assert.equal(s.audit[0].kind,'weight');assert.equal(s.products[0].weightKg,2.345678);assert.equal(s.products[1].weightKg,2.345678);assert.equal(h.calls.length,6);assert.equal(s.products[0].inventoryQuantity,8);assert.equal(s.products[0].price,10000);assert.equal(s.products[0].cost,6000);
 s=await h.save('weight',{mode:'fixed',value:'-0,345678'});assert.equal(s.products[0].weightKg,2);
 s=await h.save('weight',{mode:'percent',value:'-10'});assert.equal(s.products[0].weightKg,1.8);assert.ok(h.writes.every(w=>Object.keys(w.vars.input).join()==='measurement'));
 assert.throws(()=>changedWeight(null,'fixed','1'));assert.throws(()=>changedWeight(1,'set','-1'));assert.throws(()=>changedWeight(1,'set','1.0000001'));
});
test('stale dialog is rejected without overwriting stock, and other selected variants continue on failure',async t=>{
 const h=await productHarness(t);const d=(await h.request('product-edit/details',{id:variantId(1),field:'inventory'})).data;h.variants[0].levels[0].available=2;
 let s=await h.save('inventory',inventory([quantity(1,'10')]),[variantId(1)],{expected:d.fingerprints.inventory});assert.match(s.audit[0].detail,/άλλαξαν/);assert.equal(h.writes.length,0);
 h.variants[0].inventoryItem.tracked=false;s=await h.save('inventory',inventory([quantity(1,'10')]));assert.equal(s.audit.find(a=>a.variant_id===variantId(1)).status,'failed');assert.equal(s.audit.find(a=>a.variant_id===variantId(2)).status,'success');assert.equal(h.variants[0].levels[0].available,2);
});
test('Shopify CAS rejects a concurrent sale and no retry overwrites it',async t=>{
 const h=await productHarness(t);h.controls.beforeSet=(v,l)=>{l.available--;};const s=await h.save('inventory',inventory([quantity(1,'10')]),[variantId(1)]);assert.equal(h.variants[0].levels[0].available,2);assert.equal(s.audit[0].status,'failed');assert.equal(h.writes.length,1);assert.match(s.audit[0].detail,/mismatch/);
});
test('partial multi-step writes and network-uncertain writes are audited uncertain',async t=>{
 const h=await productHarness(t);h.variants[0].inventoryItem.tracked=false;h.controls.denyAt=2;let s=await h.save('inventory',inventory([quantity(1,'10')],true),[variantId(1)]);assert.equal(s.audit[0].status,'uncertain');assert.equal(h.variants[0].inventoryItem.tracked,true);assert.equal(h.variants[0].levels[0].available,3);assert.match(s.audit[0].detail,/μερική/);
 h.controls.denyAt=null;h.controls.networkAt=3;s=await h.save('inventory',inventory([quantity(1,'10')]),[variantId(1)]);assert.equal(s.audit[0].status,'uncertain');assert.equal(h.variants[0].levels[0].available,10);assert.equal(h.writes.length,3);
});
test('inactive warehouses, decimals, duplicate selections and CSRF cannot write inventory',async t=>{
 const h=await productHarness(t);const s=await h.save('inventory',inventory([quantity(4,'5')]),[variantId(1)]);assert.match(s.audit[0].detail,/ενεργή/);
 const body={requestId:randomUUID(),field:'inventory',ids:[variantId(1)],data:inventory([quantity(1,'4')])};
 for(const data of [inventory([quantity(1,'1.5')]),inventory([quantity(1,'4')],false),inventory([quantity(1,'1000001')])])assert.equal((await h.request('product-edit/save',{...body,data})).status,400);
 assert.equal((await h.request('product-edit/save',{...body,ids:[variantId(1),variantId(1)]})).status,400);assert.equal((await h.request('product-edit/save',body,{'X-CSRF-Token':''})).status,403);assert.equal(h.writes.length,0);
});
test('readback mismatch never records success and in-flight direct writes block other operations',async t=>{
 const h=await productHarness(t);let release;h.controls.wait=new Promise(r=>release=r);await h.request('product-edit/save',{requestId:randomUUID(),field:'weight',data:{mode:'set',value:'3'},ids:[variantId(1)]});for(let i=0;i<30&&!h.writes.length;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal((await h.request('product-edit/save',{requestId:randomUUID(),field:'weight',ids:[variantId(1)],data:{mode:'set',value:'4'}})).status,409);
 h.controls.onRead=(v,count)=>{if(count)v.inventoryItem.measurement.weight.value=4;};release();const s=await h.idle();assert.equal(s.audit[0].status,'uncertain');assert.equal(s.products[0].weightKg,1.25);
});
test('direct bulk supports 2000 variants with progress and SKU logs, without re-reading locations per variant',async t=>{
 const h=await productHarness(t,2000);const s=await h.save('weight',{mode:'set',value:'2'});assert.equal(s.job.completed,2000);assert.equal(s.audit.length,2000);assert.ok(s.audit.every(a=>a.status==='success'&&a.sku.startsWith('TEST-')));assert.equal(h.writes.length,2000);assert.equal(h.calls.length,6000);
});
test('refresh after activation cannot adopt and overwrite a concurrent change at another warehouse',async t=>{
 const h=await productHarness(t);h.variants[0].levels[0].active=false;h.variants[0].levels[0].available=0;
 let changed=false;h.controls.onRead=(v,count)=>{if(count===1&&!changed){v.levels[1].available=4;changed=true;}};
 const s=await h.save('inventory',inventory([quantity(1,'2'),quantity(2,'10')]),[variantId(1)]);assert.equal(s.audit[0].status,'uncertain');assert.equal(h.variants[0].levels[0].available,2);assert.equal(h.variants[0].levels[1].available,4);assert.equal(h.writes.at(-1).vars.input.quantities[0].changeFromQuantity,5);
});
test('duplicate direct requests cannot repeat relative stock changes and old preview routes are removed',async t=>{
 const h=await productHarness(t),body={requestId:randomUUID(),field:'inventory',ids:[variantId(1)],data:inventory([quantity(1,'2','fixed')])};
 assert.equal((await h.request('product-edit/save',body)).status,200);await h.idle();assert.equal(h.variants[0].levels[0].available,5);const count=h.writes.length;
 assert.equal((await h.request('product-edit/save',body)).data.duplicate,true);assert.equal(h.writes.length,count);assert.equal(h.variants[0].levels[0].available,5);
 assert.equal((await h.request('product-edit/save',{...body,data:inventory([quantity(1,'3','fixed')])})).status,400);
 for(const action of ['preview','apply'])assert.equal((await h.request('product-edit/'+action,body)).status,400);
});
