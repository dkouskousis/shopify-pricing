import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTable,buildPublicTable,replacePublicTable,createPublicShippingTable,PUBLIC_TABLE_QUERIES } from '../shipping-public-table.mjs';
import { SHIPPING_QUERIES } from '../shipping.mjs';
import { openStore } from '../store.mjs';
const body='<h2>Shipping</h2><div class="shipping-table-wrapper"><table class="shipping-table" data-keep="yes"><thead><tr><th>Weight</th><th>Zone 1</th><th>Zone 4</th></tr></thead><tbody><tr><td>up to 1 kg</td><td class="keep">16 €</td><td>40 €</td></tr><tr><td>up to 5 kg</td><td>30 €</td><td>57 €</td></tr></tbody></table></div><div class="countries"><p>Zone 4: United States, Canada, Mexico</p></div><table><tr><td>Delivery times stay</td></tr></table><p>Returns unchanged</p>';
const source=zoneId=>({profileId:'p',groupId:'g',zoneId,methodId:'method-'+zoneId});
const row=(zone,max,price)=>({...source(zone),id:zone+'-'+max,zoneName:zone,active:true,editable:true,type:'DeliveryRateDefinition',price,currency:'EUR',rateGroupId:'group-'+zone,providerId:'rate-'+zone+'-'+max,conditions:[{field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:max,unit:'KILOGRAMS'}},{field:'TOTAL_WEIGHT',operator:'GREATER_THAN_OR_EQUAL_TO',conditionCriteria:{value:max===1?0:1.001,unit:'KILOGRAMS'}}],rangeConditions:[],freeConditions:[],countries:[]});
const rows=[row('EU',1,1600),row('EU',5,3000),row('US',1,5300),row('US',5,7000)];
const config=table=>({layoutSignature:table.layoutSignature,cells:[[source('EU'),source('US')],[source('US'),null]]});
test('each public cell maps independently without adding columns, changing labels, countries or unrelated HTML',()=>{
 const table=currentTable(body);assert.deepEqual(table.weights,[1,5]);const built=buildPublicTable(rows,config(table),table);
 assert.deepEqual(built.matrix.rows,[['up to 1 kg','16 €','53 €'],['up to 5 kg','70 €','57 €']]);assert.deepEqual(built.matrix.headers,['Weight','Zone 1','Zone 4']);
 const result=replacePublicTable(body,built.matrix);assert.equal(result,body.replace('<td>40 €</td>','<td>53 €</td>').replace('<td>30 €</td>','<td>70 €</td>'));
 assert.match(result,/<td class="keep">16 €/);assert.match(result,/Delivery times stay/);assert.match(result,/Returns unchanged/);
});
test('missing, ambiguous, value-dependent and dynamic rates never get guessed or published',()=>{
 const table=currentTable(body),c=config(table);
 assert.throws(()=>buildPublicTable(rows.filter(r=>r.zoneId!=='US'),c,table),/χρεώσεις EUR/);
 assert.throws(()=>buildPublicTable([...rows,{...rows[2],id:'duplicate'}],c,table),/περισσότερες/);
 assert.throws(()=>buildPublicTable(rows.map(r=>r.zoneId==='US'?{...r,conditions:[{field:'TOTAL_PRICE'}]}:r),c,table),/αξία/);
 assert.throws(()=>buildPublicTable(rows.map(r=>({...r,editable:false})),c,table),/χρεώσεις EUR/);
 assert.throws(()=>buildPublicTable(rows,{...c,layoutSignature:'stale'},table),/δομή/);
 assert.throws(()=>replacePublicTable(body,{headers:['Weight','Extra'],rows:[]}),/στήλες/);
});
test('HTML locator rejects duplicate or merged target tables and ignores unrelated comments and script text',()=>{
 assert.throws(()=>currentTable(body.replace('class="shipping-table"','data-class="shipping-table"')),/μοναδικό/);
 assert.throws(()=>currentTable(body+body),/μοναδικό/);assert.throws(()=>currentTable(body.replace('<td class="keep">','<td colspan="2">')),/συγχωνευμένα/);
 assert.deepEqual(currentTable('<!-- <table class="shipping-table"></table> --><script>"<table class=\'shipping-table\'>"</script>'+body).rows,currentTable(body).rows);
});
function harness(t) {
 const store=openStore(':memory:','cc'.repeat(32));t.after(()=>store.db.close());
 let page={id:'gid://shopify/Page/1',title:'Shipping & Returns',handle:'shipping-returns-2',body,updatedAt:'2026-10-19T12:00:00Z'},writes=[],fail='',changed=false;
 const pageApi=async(q,v)=>{
  if(q===PUBLIC_TABLE_QUERIES.find)return{pages:{nodes:[structuredClone(page)],pageInfo:{hasNextPage:false,endCursor:null}}};
  if(q===PUBLIC_TABLE_QUERIES.page){if(fail==='readback'&&writes.length)throw new Error('Readback failed');return{page:structuredClone(page)};}
  if(q===PUBLIC_TABLE_QUERIES.update){writes.push(structuredClone(v));if(fail==='network')throw new Error('Network failure');if(fail==='denied')return{pageUpdate:{userErrors:[{message:'Missing write_content'}]}};page.body=v.page.body;page.updatedAt='2026-10-19T13:00:00Z';return{pageUpdate:{page:{id:page.id},userErrors:[]}};}
  throw new Error('Unexpected page query');
 };
 const shippingApi=async(q,v)=>{
  if(q===SHIPPING_QUERIES.zone)return{deliveryProfile:{profileLocationGroups:[{locationGroup:{id:'g'},locationGroupZones:{edges:[{node:{zone:{id:'EU',name:'EU',countries:[]},methodDefinitions:{nodes:[{id:'method-EU',name:'DHL',active:true,currencyCode:'EUR',description:'',freeConditions:[]}],pageInfo:{hasNextPage:false}}}}],pageInfo:{hasNextPage:false}}}]}};
  if(q===SHIPPING_QUERIES.providers)return{node:{id:'method-EU',rateGroups:{nodes:[{id:'rg1',rateProviders:{nodes:[1,5].map((max,i)=>({__typename:'DeliveryRateDefinition',id:'r'+i,price:{amount:String((i?31:17)+(changed?1:0)),currencyCode:'EUR'},minTransitTime:null,maxTransitTime:null,conditions:[{subject:'PACKAGE_WEIGHT',min:{value:i?1.001:0,unit:'KILOGRAMS'},max:{value:max,unit:'KILOGRAMS'}}]})),pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}};
  throw new Error('Unexpected shipping query');
 };
 const service=createPublicShippingTable({store,graphql:()=>pageApi,shippingGraphql:()=>shippingApi,safeError:e=>e.message});
 const c={layoutSignature:currentTable(body).layoutSignature,cells:[[source('EU'),null],[source('EU'),null]]};
 return {service,store,c,writes,editPage:()=>{page.body+='<p>External edit</p>';},changeRates:()=>{changed=true;},setFailure:v=>{fail=v;},page:()=>page};
}
test('preview never writes; publication replaces only mapped amounts and verifies saved page with backup/history',async t=>{
 const h=harness(t);const p=await h.service.handle('/api/shipping/public-table/preview',h.c);assert.equal(h.writes.length,0);assert.equal(p.changed,true);
 await h.service.handle('/api/shipping/public-table/publish',{id:p.id});assert.equal(h.writes.length,1);assert.deepEqual(Object.keys(h.writes[0].page),['body']);
 assert.equal(h.page().body,body.replace('<td class="keep">16 €</td>','<td class="keep">17 €</td>').replace('<td>30 €</td>','<td>31 €</td>'));
 assert.equal(h.store.get('publicTableBackup').body,body);assert.equal(h.store.db.prepare('SELECT status,kind FROM audit').get().status,'success');
 await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:p.id}),/χρησιμοποιήθηκε/);
});
test('external page edits and changed rates reject stale previews without writes',async t=>{
 const h=harness(t);let p=await h.service.handle('/api/shipping/public-table/preview',h.c);h.editPage();await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:p.id}),/σελίδα άλλαξε/);assert.equal(h.writes.length,0);
 p=await h.service.handle('/api/shipping/public-table/preview',h.c);h.changeRates();await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:p.id}),/χρεώσεις Shopify άλλαξαν/);assert.equal(h.writes.length,0);
});
test('denied writes are failed, network writes uncertain, and neither retries automatically',async t=>{
 const h=harness(t);let p=await h.service.handle('/api/shipping/public-table/preview',h.c);h.setFailure('denied');await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:p.id}),/write_content/);assert.equal(h.store.db.prepare('SELECT status FROM audit ORDER BY id DESC LIMIT 1').get().status,'failed');
 p=await h.service.handle('/api/shipping/public-table/preview',h.c);h.setFailure('network');await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:p.id}),/Network/);assert.equal(h.store.db.prepare('SELECT status FROM audit ORDER BY id DESC LIMIT 1').get().status,'uncertain');assert.equal(h.writes.length,2);
});
test('cell assignments persist independently of publishing, including explicitly unassigned cells',async t=>{
 const h=harness(t);await h.service.handle('/api/shipping/public-table/load',{});await h.service.handle('/api/shipping/public-table/mapping',h.c);
 assert.deepEqual(h.service.state().config,h.c);assert.equal(h.writes.length,0);
 const cleared={...h.c,cells:[[null,null],[null,null]]};await h.service.handle('/api/shipping/public-table/mapping',cleared);assert.deepEqual(h.service.state().config,cleared);
 await assert.rejects(h.service.handle('/api/shipping/public-table/preview',cleared),/τουλάχιστον/);assert.equal(h.writes.length,0);
});
test('a missing readback cannot report a successful publication',async t=>{
 const h=harness(t);const preview=await h.service.handle('/api/shipping/public-table/preview',h.c);
 h.setFailure('readback');await assert.rejects(h.service.handle('/api/shipping/public-table/publish',{id:preview.id}));
 assert.equal(h.service.state().lastPublished,null);assert.equal(h.store.get('publicTablePage').table.rows[0][1],'16 €');
});
