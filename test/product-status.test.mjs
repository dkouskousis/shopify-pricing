import test from 'node:test';import assert from 'node:assert/strict';
import {productHarness,variantId} from './helpers/product-edit-fixture.mjs';
import {columnPreferences} from '../public/product-columns.mjs';
import {cleanNumber} from '../public/numeric.mjs';
import {decimal,priceMultiplier,bulkAmount} from '../public/pricing.mjs';
import {changedWeight} from '../product-edit.mjs';
test('pasted decorated amounts preserve decimals and signs and reject malformed text',()=>{
 for(const [input,output]of [['€ 12,50','12.50'],['1.234,56 €','1234.56'],['$1,234.56','1234.56'],['− 10 %','-10'],['1\u00a0234,56','1234.56'],['1,2,3','1.2,3'],['abc12€','abc12']])assert.equal(cleanNumber(input),output);
 assert.equal(decimal('€ 1.234,56'),123456);assert.equal(priceMultiplier(' 1,55 '),15500);assert.equal(bulkAmount(10000,'percent','− 10%'),9000);assert.equal(changedWeight(1,'fixed',' € 0,25 '),1.25);
 for(const value of ['abc12€','1,2,3','1.23,45','- 5 €'])assert.throws(()=>decimal(value));
});
test('column widths migrate old preferences, validate bounds, and persist',async t=>{
 const p=columnPreferences();assert.deepEqual(columnPreferences({order:p.order,hidden:[]}).widths,{});
 for(const widths of [{status:47},{status:1201},{nope:100},{status:100.5},[]])assert.throws(()=>columnPreferences({...p,widths}));
 const h=await productHarness(t);p.widths={product:600,status:85};assert.equal((await h.request('preferences/products',p)).status,200);assert.deepEqual((await h.request('state')).data.productColumns.widths,p.widths);
});
test('status details are read-only and one selected variant updates all siblings, with bulk deduplication',async t=>{
 const h=await productHarness(t,3);const d=await h.request('product-status/details',{id:variantId(1)});assert.equal(d.data.status,'ACTIVE');assert.equal(h.writes.length,0);
 assert.equal((await h.request('product-status/save',{ids:h.variants.map(v=>v.id),status:'DRAFT'})).status,200);const s=await h.idle();assert.equal(h.writes.length,1);assert.equal(s.job.total,1);assert.ok(s.products.every(p=>p.status==='DRAFT'));assert.equal(s.audit[0].kind,'status');assert.equal(s.audit[0].status,'success');
 await h.request('product-status/save',{ids:[variantId(1)],status:'UNLISTED',expected:'DRAFT'});const after=await h.idle();assert.ok(after.products.every(p=>p.status==='UNLISTED'));assert.equal(h.writes.length,2);
});
test('status rejects stale, invalid and unauthorized input, and skips unchanged products',async t=>{
 const h=await productHarness(t);assert.equal((await h.request('product-status/save',{ids:[variantId(1)],status:'INVALID'})).status,400);assert.equal((await h.request('product-status/save',{ids:[variantId(1)],status:'DRAFT'},{'X-CSRF-Token':''})).status,403);
 await h.request('product-status/save',{ids:[variantId(1)],status:'ACTIVE'});await h.idle();assert.equal(h.writes.length,0);
 h.variants[0].product.status='ARCHIVED';await h.request('product-status/save',{ids:[variantId(1)],status:'DRAFT',expected:'ACTIVE'});const s=await h.idle();assert.equal(h.writes.length,0);assert.equal(s.audit[0].status,'failed');assert.match(s.audit[0].detail,/άλλαξε/);
});
test('status denied or uncertain writes retain cache and are never retried',async t=>{
 for(const control of ['statusDenied','statusNetwork','statusKeep'])await t.test(control,async t=>{
  const h=await productHarness(t);h.controls[control]=true;await h.request('product-status/save',{ids:[variantId(1)],status:'DRAFT'});const s=await h.idle();assert.equal(h.writes.length,1);assert.ok(s.products.every(p=>p.status==='ACTIVE'));assert.equal(s.audit[0].status,control==='statusDenied'?'failed':'uncertain');
 });
});
test('bulk status continues other products and excludes unselected products',async t=>{
 const h=await productHarness(t,3);for(let i=1;i<3;i++){h.variants[i].product.id='gid://shopify/Product/'+(i+1);const v=h.app.store.variant(variantId(i+1));h.app.store.db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({...v,productId:h.variants[i].product.id}),v.id);}
 h.variants[0].product.status='ARCHIVED';await h.request('product-status/save',{ids:[variantId(1),variantId(2)],status:'DRAFT'});const s=await h.idle();assert.equal(h.writes.length,1);assert.equal(s.products.find(p=>p.id===variantId(2)).status,'DRAFT');assert.equal(s.products.find(p=>p.id===variantId(3)).status,'ACTIVE');assert.equal(s.job.completed,2);
});
test('a running status update blocks concurrent Shopify writes',async t=>{
 const h=await productHarness(t);let release;h.controls.wait=new Promise(r=>release=r);await h.request('product-status/save',{ids:[variantId(1)],status:'DRAFT'});
 for(let i=0;i<50&&!h.writes.length;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal((await h.request('product-status/save',{ids:[variantId(1)],status:'ARCHIVED'})).status,409);release();assert.equal((await h.idle()).audit[0].status,'success');
});
test('direct stock and weight saves accept decorated pasted amounts',async t=>{
 const h=await productHarness(t);let s=await h.save('weight',{mode:'set',value:' € 1,50 '},[variantId(1)]);assert.equal(s.audit[0].status,'success');assert.equal(s.products[0].weightKg,1.5);
 s=await h.save('inventory',{tracked:null,policy:null,quantities:[{locationId:h.locations[0].id,mode:'set',value:' 12 € '}]},[variantId(1)]);assert.equal(s.audit[0].status,'success');assert.equal(s.products[0].inventoryQuantity,17);
});
