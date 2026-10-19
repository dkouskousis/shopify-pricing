import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRate, destinationRates, rateGroups, weightLimit} from '../public/shipping-summary.mjs';
const country=code=>({name:code,code:{countryCode:code,restOfWorld:false}});
const weight=(operator,value,unit='KILOGRAMS')=>({field:'TOTAL_WEIGHT',operator,conditionCriteria:{value,unit}});
const amount=value=>({field:'TOTAL_PRICE',operator:'GREATER_THAN_OR_EQUAL_TO',conditionCriteria:{amount:String(value),currencyCode:'EUR'}});
const row=(id,extra={})=>({id,profileId:'p1',profileName:'General',groupId:'g1',zoneId:'z1',zoneName:'Zone 1',methodId:'m1',name:'Express',active:true,type:'DeliveryRateDefinition',price:1000,currency:'EUR',conditions:[],countries:[country('GR')],...extra});
test('country and exact weight ranges select all matching active methods without selecting a cheapest rate',()=>{
 const rows=[row('a',{conditions:[weight('LESS_THAN_OR_EQUAL_TO',1)]}),row('b',{conditions:[weight('GREATER_THAN_OR_EQUAL_TO',1.001),weight('LESS_THAN_OR_EQUAL_TO',5)],price:2000}),row('c',{methodId:'m2',price:3000}),row('off',{methodId:'m3',active:false}),row('abroad',{countries:[country('US')]})];
 assert.deepEqual(destinationRates(rows,'GR',1).map(x=>x.row.id),['a','c']);
 assert.deepEqual(destinationRates(rows,'GR',1.001).map(x=>x.row.id),['b','c']);
 assert.deepEqual(destinationRates(rows,'US',1).map(x=>x.row.id),['abroad']);
 assert.equal(destinationRates(rows,'GR',0).length,0);assert.equal(destinationRates(rows,'GR',NaN).length,0);
 assert.equal(rateGroups(rows).length,3);
});
test('weight conversion uses grams, pounds and ounces and retains real tier gaps',()=>{
 assert.equal(weightLimit(weight('LESS_THAN_OR_EQUAL_TO',1000,'GRAMS')),1);
 assert.equal(checkRate(row('a',{conditions:[weight('LESS_THAN_OR_EQUAL_TO',16,'OUNCES')]}),.45359237),'available');
 assert.equal(checkRate(row('a',{conditions:[weight('LESS_THAN_OR_EQUAL_TO',1,'POUNDS')]}),.454),'excluded');
 assert.equal(checkRate(row('a',{conditions:[weight('GREATER_THAN_OR_EQUAL_TO',2),weight('LESS_THAN_OR_EQUAL_TO',5)]}),1.9),'excluded');
});
test('order thresholds remain conditional until an order amount is provided, confirmed free shipping replaces paid service only',()=>{
 const rows=[row('paid'),row('free',{type:'FreeCondition',conditions:[amount(150)],price:0}),row('other',{methodId:'m2',price:2000})];
 assert.deepEqual(destinationRates(rows,'GR',1).map(x=>[x.row.id,x.status]),[['paid','available'],['free','conditional'],['other','available']]);
 assert.deepEqual(destinationRates(rows,'GR',1,149.99).map(x=>x.row.id),['paid','other']);
 assert.deepEqual(destinationRates(rows,'GR',1,150).map(x=>x.row.id),['free','other']);
 assert.equal(checkRate(row('a',{conditions:[amount(20),weight('LESS_THAN_OR_EQUAL_TO',1)]}),2),'excluded');
 assert.equal(checkRate(row('a',{conditions:[{...amount(20),conditionCriteria:{amount:'20',currencyCode:'USD'}}]}),1,25),'conditional');
});
test('rest of world applies only outside explicit zones within the same profile and location group',()=>{
 const rest={name:'Rest of world',code:{countryCode:null,restOfWorld:true}};
 const rows=[row('local',{active:false}),row('world',{zoneId:'world',countries:[rest]}),row('other-group',{groupId:'g2',zoneId:'world',countries:[rest]}),row('other-profile',{profileId:'p2',zoneId:'world',countries:[rest]})];
 assert.deepEqual(destinationRates(rows,'GR',1).map(x=>x.row.id),['other-group','other-profile']);
 assert.equal(destinationRates(rows,'FR',1).length,3);
});
test('automatic carrier rates remain available without inventing a price and overlaps are preserved',()=>{
 const rows=[row('carrier',{type:'DeliveryParticipant',price:null,currency:null}),row('same',{price:2000})];
 const result=destinationRates(rows,'GR',2);assert.equal(result.length,2);assert.equal(result[0].row.price,null);
});
