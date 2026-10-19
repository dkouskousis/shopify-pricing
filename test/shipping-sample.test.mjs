import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDefaults } from '../public/shipping-sample.mjs';
const today = '2026-10-19';
const row = { countries: [{code:{countryCode:'DE',restOfWorld:false}}, {code:{countryCode:'FR',restOfWorld:false}}], conditions: [{field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:5,unit:'KILOGRAMS'}}] };
test('sample autofill chooses a zone country, its capital, tier maximum and requested parcel values',()=>{
  assert.deepEqual(sampleDefaults(row,today),{destinationCountryCode:'DE',destinationCityName:'Berlin',destinationPostalCode:'10115',plannedShippingDate:today,weight:'5',length:'10',width:'10',height:'10'});
});
test('autofill converts upper weight bounds to kg and respects the tightest condition',()=>{
  const conditions = [
    {field:'TOTAL_WEIGHT',operator:'GREATER_THAN_OR_EQUAL_TO',conditionCriteria:{value:1,unit:'KILOGRAMS'}},
    {field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:2500,unit:'GRAMS'}},
    {field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:3,unit:'KILOGRAMS'}},
    {field:'TOTAL_PRICE',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{amount:'100.00',currencyCode:'EUR'}}
  ];
  assert.equal(sampleDefaults({...row,conditions},today).weight,'2.5');
  const pounds=[{field:'TOTAL_WEIGHT',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{value:5,unit:'POUNDS'}}];
  assert.equal(sampleDefaults({...row,conditions:pounds},today).weight,'2.267');
});
test('unbounded and order-value tiers do not invent a maximum weight',()=>{
  for(const conditions of [[],[{field:'TOTAL_WEIGHT',operator:'GREATER_THAN_OR_EQUAL_TO',conditionCriteria:{value:5,unit:'KILOGRAMS'}}],[{field:'TOTAL_PRICE',operator:'LESS_THAN_OR_EQUAL_TO',conditionCriteria:{amount:'100.00',currencyCode:'EUR'}}]])assert.equal(sampleDefaults({...row,conditions},today).weight,'');
});
test('rest of world requires an explicit country and countries without a capital require a city',()=>{
  const all={...row,countries:[{code:{countryCode:null,restOfWorld:true}}]};
  assert.equal(sampleDefaults(all,today).destinationCountryCode,'');assert.equal(sampleDefaults(all,today).destinationCityName,'');
  assert.equal(sampleDefaults({...row,countries:[{code:{countryCode:'AQ',restOfWorld:false}}]},today).destinationCityName,'');
});
test('autofill does not mutate the shipping tier or the existing sample',()=>{
  const existing={...row,sample:{length:35,weight:2,isCustomsDeclarable:true}};const before=structuredClone(existing);sampleDefaults(existing,today);assert.deepEqual(existing,before);
});

test('postal codes are matched to the selected city, including full alphanumeric codes and leading zeroes',()=>{
  const expected={DE:['Berlin','10115'],FR:['Paris','75001'],GR:['Athens','10682'],GB:['London','SW1A 1AA'],CA:['Ottawa','K1A 0A6'],IE:['Dublin','D02 R583'],NL:['Amsterdam','1012 JS'],IT:['Rome','00184'],US:['Washington','20001'],AT:['Vienna','1010'],SG:['Singapore','178880']};
  for(const[code,[city,postal]]of Object.entries(expected)){
    const values=sampleDefaults({...row,countries:[{code:{countryCode:code,restOfWorld:false}}]},today);
    assert.equal(values.destinationCountryCode,code);assert.equal(values.destinationCityName,city);assert.equal(values.destinationPostalCode,postal);
  }
});
test('autofill leaves unknown postal codes empty rather than reusing a placeholder',()=>{
  for(const code of ['AF','AE','HK','AQ'])assert.equal(sampleDefaults({...row,countries:[{code:{countryCode:code,restOfWorld:false}}]},today).destinationPostalCode,'');
  const noCountry=sampleDefaults({...row,countries:[{code:{countryCode:null,restOfWorld:true}}]},today);assert.equal(noCountry.destinationPostalCode,'');
});
