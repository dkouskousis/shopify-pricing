import test from 'node:test';import assert from 'node:assert/strict';
import {productHarness,variantId} from './helpers/product-edit-fixture.mjs';
import {columnPreferences} from '../public/product-columns.mjs';
test('column preferences keep all IDs unique and preserve required columns',()=>{
 const p=columnPreferences();assert.equal(p.order.length,14);assert.equal(p.order[0],'select');
 for(const x of [{...p,order:[...p.order.slice(1),'select']},{...p,hidden:['product']},{...p,order:p.order.map(id=>id==='status'?'product':id)},{...p,hidden:['unknown']}])assert.throws(()=>columnPreferences(x));
});
test('column visibility and order persist after logout/login and server storage, without Shopify writes',async t=>{
 const h=await productHarness(t),p=columnPreferences();[p.order[1],p.order[2]]=[p.order[2],p.order[1]];p.hidden=['vat','fixed'];
 assert.equal((await h.request('preferences/products',p)).status,200);assert.deepEqual((await h.request('state')).data.productColumns,p);assert.deepEqual(h.app.store.get('productColumns'),p);
 assert.equal((await h.request('preferences/products',{...p,hidden:['select']})).status,400);
 assert.equal((await h.request('preferences/products',p,{'X-CSRF-Token':''})).status,403);
 await h.request('logout',{});await h.request('login',{password:h.config.password});assert.deepEqual((await h.request('state')).data.productColumns,p);assert.equal(h.writes.length,0);
});
test('deletion preparation is read-only, requires exact title and removes all variants of only the confirmed product after async confirmation',async t=>{
 const h=await productHarness(t,3);h.variants[2].product.id='gid://shopify/Product/2';const cached=h.app.store.variant(variantId(3));h.app.store.db.prepare('UPDATE variants SET data=? WHERE id=?').run(JSON.stringify({...cached,productId:h.variants[2].product.id}),cached.id);
 const d=(await h.request('product-delete/details',{variantId:variantId(1)})).data;assert.equal(d.product.variantsCount.count,2);assert.equal(h.writes.length,0);
 assert.equal((await h.request('product-delete/confirm',{token:d.token,confirmTitle:'wrong'})).status,400);
 assert.equal((await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title},{'X-CSRF-Token':''})).status,403);
 h.controls.deletePendingPolls=2;assert.equal((await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title})).status,200);const s=await h.idle();
 assert.equal(s.job.error,null);assert.equal(s.products.length,1);assert.equal(s.products[0].id,variantId(3));assert.equal(s.audit[0].kind,'delete');assert.equal(s.audit[0].status,'success');assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0].vars,{input:{id:'gid://shopify/Product/1'}});
 assert.equal((await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title})).status,400);
});
test('stale deletion confirmation refuses deletion and preserves local variants',async t=>{
 const h=await productHarness(t);const d=(await h.request('product-delete/details',{variantId:variantId(1)})).data;h.controls.productUpdatedAt='2026-10-23T11:00:00Z';await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title});const s=await h.idle();assert.match(s.job.error,/άλλαξε/);assert.equal(h.writes.length,0);assert.equal(s.products.length,2);assert.equal(s.audit[0].status,'failed');
});
test('denied, uncertain, wrong-target and unverified deletions never remove local products or retry',async t=>{
 for(const control of ['deleteDenied','deleteNetwork','wrongDeletedId','keepDeletedProduct']){
  await t.test(control,async t=>{const h=await productHarness(t);const d=(await h.request('product-delete/details',{variantId:variantId(1)})).data;h.controls[control]=control==='wrongDeletedId'?'gid://shopify/Product/WRONG':true;
   await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title});const s=await h.idle();assert.ok(s.job.error);assert.equal(s.products.length,2);assert.equal(s.audit[0].status,control==='deleteDenied'?'failed':'uncertain');assert.equal(h.writes.length,1);
   assert.equal((await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title})).status,400);assert.equal(h.writes.length,1);
  });
 }
});
test('deletion in flight blocks a concurrent product write and preserves progress until completion',async t=>{
 const h=await productHarness(t);let release;h.controls.deleteWait=new Promise(r=>release=r);const d=(await h.request('product-delete/details',{variantId:variantId(1)})).data;await h.request('product-delete/confirm',{token:d.token,confirmTitle:d.product.title});
 for(let i=0;i<30&&!h.writes.length;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal((await h.request('product-delete/details',{variantId:variantId(1)})).status,409);release();const s=await h.idle();assert.equal(s.products.length,0);assert.equal(s.job.completed,1);
});
