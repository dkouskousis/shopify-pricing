const factors = { KILOGRAMS:1, GRAMS:.001, POUNDS:.45359237, OUNCES:.028349523125 };
export const sourceKey = row => JSON.stringify([row.profileId,row.groupId,row.zoneId,row.methodId]);
export function weightLimit(condition) {
  const c=condition.conditionCriteria;
  return condition.field==='TOTAL_WEIGHT' && factors[c.unit] ? c.value*factors[c.unit] : null;
}
export function checkRate(row, weight, orderValue=null) {
  let conditional=false;
  for (const c of row.conditions) {
    const limit=c.field==='TOTAL_WEIGHT'?weightLimit(c):c.field==='TOTAL_PRICE'&&c.conditionCriteria.currencyCode==='EUR'?Number(c.conditionCriteria.amount):null;
    const actual=c.field==='TOTAL_WEIGHT'?weight:c.field==='TOTAL_PRICE'?orderValue:null;
    if(limit===null || actual===null){conditional=true;continue;}
    if (!['GREATER_THAN_OR_EQUAL_TO','LESS_THAN_OR_EQUAL_TO'].includes(c.operator)) {conditional=true;continue;}
    if(c.operator==='GREATER_THAN_OR_EQUAL_TO'?actual+1e-9<limit:actual-1e-9>limit)return 'excluded';
  }
  return conditional?'conditional':'available';
}
export function rateGroups(rows) {
  const groups=new Map();
  for(const row of rows){const key=sourceKey(row);if(!groups.has(key))groups.set(key,{key,row,rates:[]});groups.get(key).rates.push(row);}
  return [...groups.values()].sort((a,b)=>a.row.zoneName.localeCompare(b.row.zoneName,undefined,{numeric:true})||a.row.name.localeCompare(b.row.name));
}
export function destinationRates(rows,country,weight,orderValue=null) {
  if(!country || !Number.isFinite(weight)||weight<=0 || (orderValue!==null&&(!Number.isFinite(orderValue)||orderValue<0)))return [];
  const active=rows.filter(r=>r.active);
  const explicitlyCovered=new Set(rows.filter(r=>r.countries.some(c=>c.code.countryCode===country&&!c.code.restOfWorld)).map(r=>JSON.stringify([r.profileId,r.groupId])));
  const candidates=active.filter(r=>r.countries.some(c=>c.code.countryCode===country&&!c.code.restOfWorld)||(!explicitlyCovered.has(JSON.stringify([r.profileId,r.groupId]))&&r.countries.some(c=>c.code.restOfWorld)));
  return rateGroups(candidates).flatMap(group=>{
    const matches=group.rates.map(row=>({row,status:checkRate(row,weight,orderValue)})).filter(r=>r.status!=='excluded');
    // A confirmed free condition replaces paid rates for this service only.
    const free=matches.filter(r=>r.row.type==='FreeCondition'&&r.status==='available');
    return free.length?free:matches;
  });
}
