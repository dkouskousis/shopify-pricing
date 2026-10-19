import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { postalText, refreshDestination, editDestination, directoryState } from '../postal-directory.mjs';
import { sampleDefaults, destinations } from '../public/shipping-sample.mjs';
import { createShippingService } from '../shipping-service.mjs';
import { openStore } from '../store.mjs';
import { createDhl } from '../dhl.mjs';
function zip(code, text) {
  const data = Buffer.from(text), compressed = deflateRawSync(data), name = Buffer.from(code+'.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8,8); local.writeUInt16LE(name.length,26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8,10); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+name.length,12); end.writeUInt32LE(local.length+name.length+compressed.length,16);
  return Buffer.concat([local,name,compressed,central,name,end]);
}
const mockFetch = (metadata, text) => async url => new Response(url.includes('gstatic.com') ? JSON.stringify(metadata) : zip(metadata.key,text));
test('online refresh recognizes UAE without a postal code and matches Dhaka GPO with a complete code', async()=>{
  const ae = await refreshDestination('AE',destinations.AE,mockFetch({key:'AE',fmt:'%A%n%C'},''));
  assert.equal(ae.noPostalCode,true); assert.equal(ae.postalCode,''); assert.match(ae.source,/gstatic/);
  const bd = await refreshDestination('BD',destinations.BD,mockFetch({key:'BD',fmt:'%C %Z',zip:'\\d{4}'},'BD\t1200\tOther City\nBD\t1000\tDhaka GPO\n'));
  assert.equal(bd.postalCode,'1000'); assert.equal(bd.city,'Dhaka'); assert.equal(bd.noPostalCode,false); assert.ok(bd.updatedAt);
});
test('online refresh rejects wrong cities, truncated codes, malformed source data and remote failures',async()=>{
  await assert.rejects(refreshDestination('CA',destinations.CA,mockFetch({key:'CA',fmt:'%Z',zip:'[A-Z]\\d[A-Z] \\d[A-Z]\\d'},'CA\tK1A\tOttawa')),/πλήρης ΤΚ/);
  await assert.rejects(refreshDestination('DE',destinations.DE,mockFetch({key:'DE',fmt:'%Z',zip:'\\d{5}'},'DE\t12345\tOther City')),/πλήρης ΤΚ/);
  await assert.rejects(refreshDestination('AE',destinations.AE,mockFetch({key:'XX',fmt:'%A'},'')),/μορφή/);
  await assert.rejects(refreshDestination('../DE',destinations.DE),/χώρα/);
  await assert.rejects(refreshDestination('DE',destinations.DE,async()=>new Response('',{status:503})),/503/);
});
test('ZIP reader accepts the named member only and rejects corruption, wrong country and excessive expansion',()=>{
  const bytes=zip('BD','BD\t1000\tDhaka GPO');assert.equal(postalText(bytes,'BD'),'BD\t1000\tDhaka GPO');
  assert.throws(()=>postalText(bytes,'DE'));assert.throws(()=>postalText(Buffer.from('broken'),'BD'));
  const bad=Buffer.from(bytes);const central=bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bad.writeUInt32LE(40*1024*1024,central+24);assert.throws(()=>postalText(bad,'BD'));
});
test('manual directory edits validate values and feed sample autofill without changing the tier',()=>{
  const entry=editDestination({city:'Dhaka',postalCode:'1205',noPostalCode:false},destinations.BD);
  const row={countries:[{code:{countryCode:'BD'}}],conditions:[]};
  assert.equal(sampleDefaults(row,'2026-10-19',{BD:entry}).destinationPostalCode,'1205');
  for(const change of [{city:''},{postalCode:''},{noPostalCode:'yes'},{city:'a\nb'}])assert.throws(()=>editDestination({city:'Dhaka',postalCode:'1000',noPostalCode:false,...change},destinations.BD));
  assert.equal(editDestination({city:'Abu Dhabi',postalCode:'fake',noPostalCode:true},destinations.AE).postalCode,'');
});
function service(t, fetcher) {
  const store=openStore(':memory:','ae'.repeat(32)); t.after(()=>store.db.close()); let work,job={running:false,completed:0};
  const s=createShippingService({store,graphql:()=>{throw new Error('No Shopify writes expected');},startJob:(type,w)=>{work=w;job.type=type;},jobState:()=>job,safeError:e=>e.message,stopping:()=>false,postalFetch:fetcher});
  return {s,store,job,run:()=>work()};
}
test('persistent directory refresh reports partial failures, preserves previous entries and does not change saved samples',async t=>{
  const h=service(t,async url=>{if(url.endsWith('/AE'))return new Response(JSON.stringify({key:'AE',fmt:'%A'}));return new Response('',{status:503});});
  h.store.put('shippingSamples',{test:{city:'My saved sample'}});const before=directoryState(h.store).BD;
  await h.s.handle('/api/shipping/countries/refresh',{codes:['AE','BD']});await h.run();
  const d=h.s.state().directory;assert.equal(d.AE.noPostalCode,true);assert.equal(d.BD.postalCode,before.postalCode);assert.equal(d.BD.city,before.city);assert.match(d.BD.error,/503/);assert.ok(d.BD.attemptedAt);assert.equal(h.job.completed,2);assert.match(h.job.message,/1 ενημερώθηκαν, 1/);assert.deepEqual(h.store.get('shippingSamples'),{test:{city:'My saved sample'}});
  await assert.rejects(h.s.handle('/api/shipping/countries/refresh',{codes:['XX']}));
  await assert.rejects(h.s.handle('/api/shipping/countries/save',{code:'XX',city:'X',postalCode:'1',noPostalCode:false}));
});
test('bulk autofill uses editable directory, accepts no-postal UAE and still rejects missing codes elsewhere',async t=>{
  const h=service(t);const row=(id,code)=>({id,zoneName:code,name:'DHL',countries:[{code:{countryCode:code}}],conditions:[{field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:2,unit:'KILOGRAMS'}}]});
  h.store.put('shippingRates',[row('ae','AE'),row('bd','BD'),row('aq','AQ')]);
  await h.s.handle('/api/shipping/countries/save',{code:'BD',city:'Dhaka',postalCode:'1205',noPostalCode:false});
  const result=await h.s.handle('/api/shipping/samples/autofill',{ids:['ae','bd','aq']});assert.deepEqual(result.saved,['ae','bd']);assert.equal(result.skipped.length,1);
  const samples=h.store.get('shippingSamples');assert.equal(samples.ae.destinationPostalCode,'');assert.equal(samples.bd.destinationPostalCode,'1205');
  await assert.rejects(h.s.handle('/api/shipping/sample',{id:'bd',sample:{...samples.bd,destinationPostalCode:''}}),/ΤΚ/);
});
test('DHL omits the optional postal parameter for a country without postal codes',async()=>{
  const sample={destinationCountryCode:'AE',destinationPostalCode:'',destinationCityName:'Abu Dhabi',plannedShippingDate:new Date().toISOString().slice(0,10),weight:2,length:10,width:10,height:10,isCustomsDeclarable:true};
  let url;await createDhl({environment:'test',username:'u',password:'p',accountNumber:'123456789',originCountryCode:'GR',originPostalCode:'10557',originCityName:'Athens'},async u=>{url=new URL(u);return new Response(JSON.stringify({products:[{productCode:'P',productName:'Express',totalPrice:[{currencyType:'BILLC',priceCurrency:'EUR',price:20}]}]}));})(sample);
  assert.equal(url.searchParams.has('destinationPostalCode'),false);assert.equal(url.searchParams.get('destinationCityName'),'Abu Dhabi');
});
test('online lookup never picks an arbitrary same-name city in another region',async()=>{
 const fetcher=mockFetch({key:'CR',fmt:'%C %Z',zip:'\\d{5}'},'CR\t10101\tSan Jose\tSan Jose\t1\tCentral\t01\nCR\t20102\tSan Jose\tAlajuela\t2\tCentral\t01');
 await assert.rejects(refreshDestination('CR',{city:'San Jose',postalCode:''},fetcher),/ομώνυμες/);
 assert.equal((await refreshDestination('CR',{city:'San Jose',postalCode:'10101'},fetcher)).postalCode,'10101');
});
test('refresh-all discovers new countries and preserves a previous city/code if its replacement cannot be verified',async t=>{
 const countries=Object.entries(destinations).map(([code,e])=>[code,'','','',e.name,code==='BD'?'Changed capital':e.city].join('\t')).join('\n')+'\nZZ\t\t\t\tNew country\tNew capital';
 const h=service(t,async url=>{
  if(url.endsWith('countryInfo.txt'))return new Response(countries);
  const code=url.split('/').at(-1);if(code==='BD')return new Response('',{status:503});
  return new Response(JSON.stringify({key:code,fmt:'%A%n%C'}));
 });
 await h.s.handle('/api/shipping/countries/refresh',{});await h.run();
 const directory=h.s.state().directory;assert.equal(directory.ZZ.city,'New capital');assert.equal(directory.ZZ.noPostalCode,true);
 assert.equal(directory.BD.city,'Dhaka');assert.equal(directory.BD.postalCode,'1000');assert.match(directory.BD.error,/503/);
});
