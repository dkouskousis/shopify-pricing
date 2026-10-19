import { createHash, randomBytes } from 'node:crypto';
import { shippingRates, shippingFingerprint } from './shipping.mjs';
const handle = 'shipping-returns-2';
export const PUBLIC_TABLE_QUERIES = {
  find: `query ShippingPublicPage { pages(first: 2, query: "handle:shipping-returns-2") { nodes { id title handle body updatedAt } pageInfo { hasNextPage endCursor } } }`,
  page: `query ShippingPublicPageCheck($id: ID!) { page(id: $id) { id title handle body updatedAt } }`,
  update: `mutation ShippingPublicPageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`,
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(value);
const money = cents => `${number(cents / 100)} €`;
// Locate one existing element; keep its opening tag, closing tag and all surrounding HTML intact.
export function elementByClass(body, className) {
  const scan = body.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, m => ' '.repeat(m.length));
  const tags = [...scan.matchAll(/<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)];
  const matches = tags.map((tag,index) => ({tag,index})).filter(({tag}) => {
    if (/^<\//.test(tag[0])) return false;
    const attr = tag[0].match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return attr && (attr[1] ?? attr[2]).split(/\s+/).includes(className);
  });
  if (matches.length !== 1) throw new Error(`Δεν βρέθηκε μοναδικό τμήμα «${className}» στη σελίδα. Έλεγξε τη δομή της σελίδας.`);
  const {tag,index} = matches[0]; let depth = 1;
  for (const next of tags.slice(index + 1)) {
    if (next[1].toLowerCase() !== tag[1].toLowerCase()) continue;
    depth += /^<\//.test(next[0]) ? -1 : /\/>$/.test(next[0]) ? 0 : 1;
    if (!depth) return { start: tag.index, innerStart: tag.index + tag[0].length, innerEnd: next.index, end: next.index + next[0].length };
  }
  throw new Error('Το τμήμα της σελίδας δεν έχει έγκυρο κλείσιμο HTML.');
}
const plain = html => html.replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp|euro);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
  if (entity.startsWith('&#')) { const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3),16) : parseInt(entity.slice(2),10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' ','&euro;':'€'})[entity.toLowerCase()];
}).trim();
function tableData(body) {
  const part = elementByClass(body,'shipping-table'), html = body.slice(part.innerStart,part.innerEnd);
  const grid = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(row => {
    const rowStart = part.innerStart + row.index + row[0].indexOf('>') + 1;
    return [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(cell => {
      const open = cell[0].slice(0,cell[0].indexOf('>')+1);
      if (/\b(?:rowspan|colspan)\s*=/i.test(open)) throw new Error('Ο πίνακας έχει συγχωνευμένα κελιά και χρειάζεται έλεγχο.');
      const start = rowStart + cell.index + open.length;
      return {text:plain(cell[1]),start,end:start+cell[1].length};
    });
  });
  if (grid.length < 2 || grid.length > 51 || grid[0].length < 2 || grid[0].length > 31 || grid.some(row=>row.length!==grid[0].length)) throw new Error('Ο πίνακας χρειάζεται κανονικές γραμμές και στήλες χωρίς συγχωνευμένα κελιά.');
  const headers = grid[0].map(c=>c.text), rows = grid.slice(1).map(r=>r.map(c=>c.text));
  const weights = rows.map(row=>{
    const match = row[0].match(/^up\s+to\s+(\d+(?:[.,]\d+)?)\s*kg$/i);
    if (!match) throw new Error('Δεν αναγνωρίστηκαν τα κιλά γραμμής: '+row[0]);
    const weight = Number(match[1].replace(',','.'));
    if (weight<=0 || weight>1000) throw new Error('Μη έγκυρο βάρος στον πίνακα.');
    return weight;
  });
  return {headers,rows,weights,layoutSignature:hash([headers,rows.map(r=>r[0])]),grid};
}
export function currentTable(body) { const {grid,...table}=tableData(body);return table; }
export function validateTableConfig(input, table, allowEmpty = false) {
  if (input.layoutSignature !== table.layoutSignature || !Array.isArray(input.cells) || input.cells.length !== table.rows.length || input.cells.some(row=>!Array.isArray(row)||row.length!==table.headers.length-1)) throw new Error('Η δομή του πίνακα άλλαξε. Φόρτωσε ξανά τον πίνακα και τις αντιστοιχίσεις.');
  const cells=input.cells.map(row=>row.map(cell=>{
    if (cell===null) return null;
    if (!cell || ['profileId','groupId','zoneId','methodId'].some(k=>typeof cell[k]!=='string'||!cell[k]||cell[k].length>300)) throw new Error('Επίλεξε έγκυρη ζώνη για κάθε κελί που θα ενημερωθεί.');
    return Object.fromEntries(['profileId','groupId','zoneId','methodId'].map(k=>[k,cell[k]]));
  }));
  if (!allowEmpty && !cells.some(row=>row.some(Boolean))) throw new Error('Αντιστοίχισε τουλάχιστον ένα κελί σε ζώνη Shopify.');
  return {layoutSignature:table.layoutSignature,cells};
}
const factors = { KILOGRAMS:1, GRAMS:0.001, POUNDS:0.45359237, OUNCES:0.028349523125 };
export function buildPublicTable(rows, input, table) {
  const config=validateTableConfig(input,table), used=new Map(); let mapped=0;
  const result=table.rows.map((row,i)=>[row[0],...row.slice(1).map((existing,j)=>{
    const source=config.cells[i][j];if (!source) return existing;
    const rates=rows.filter(r=>r.profileId===source.profileId&&r.groupId===source.groupId&&r.zoneId===source.zoneId&&r.methodId===source.methodId&&r.active&&r.type!=='FreeCondition');
    if (!rates.length || rates.some(r=>!r.editable||r.currency!=='EUR'||!r.rateGroupId)) throw new Error('Η επιλεγμένη υπηρεσία δεν έχει ενεργές σταθερές χρεώσεις EUR. Συγχρόνισε και επίλεξε ξανά.');
    if (rates.some(r=>r.conditions.some(c=>c.field!=='TOTAL_WEIGHT'))) throw new Error(`Η ζώνη ${rates[0].zoneName} έχει χρεώσεις ανά αξία καλαθιού και δεν αποτυπώνεται σε πίνακα μόνο κιλών.`);
    const matches=rates.filter(r=>r.conditions.every(c=>{
      const factor=factors[c.conditionCriteria.unit];if (!factor) throw new Error('Μη υποστηριζόμενη μονάδα βάρους.');
      const limit=c.conditionCriteria.value*factor,weight=table.weights[i];
      return c.operator==='GREATER_THAN_OR_EQUAL_TO'?weight+1e-9>=limit:weight-1e-9<=limit;
    }));
    if (matches.length!==1) throw new Error(`${rates[0].zoneName}, ${number(table.weights[i])} kg: ${matches.length?'περισσότερες από μία χρεώσεις':'δεν βρέθηκε χρέωση'}. Έλεγξε τις κλίμακες.`);
    for (const rate of rates) used.set(rate.id,shippingFingerprint(rate));mapped++;
    return money(matches[0].price);
  })]);
  return {matrix:{headers:table.headers,rows:result,mapped},signature:hash([...used].sort((a,b)=>a[0].localeCompare(b[0]))),config};
}
export function replacePublicTable(body, matrix) {
  const table=tableData(body);
  if (JSON.stringify(matrix.headers)!==JSON.stringify(table.headers)||matrix.rows.length!==table.rows.length||matrix.rows.some((r,i)=>r.length!==table.headers.length||r[0]!==table.rows[i][0])) throw new Error('Οι στήλες και οι γραμμές της σελίδας πρέπει να διατηρούνται.');
  const changes=[];
  matrix.rows.forEach((row,i)=>row.slice(1).forEach((value,j)=>{if (value!==table.rows[i][j+1]) changes.push({...table.grid[i+1][j+1],value});}));
  let result=body;
  for (const cell of changes.sort((a,b)=>b.start-a.start)) result=result.slice(0,cell.start)+escape(cell.value)+result.slice(cell.end);
  return result;
}
export function createPublicShippingTable({ store, graphql, shippingGraphql, safeError }) {
  const plans = new Map();
  const pageInfo = page => ({ id:page.id,title:page.title,handle:page.handle,updatedAt:page.updatedAt,table:currentTable(page.body) });
  async function findPage() {
    const result = (await graphql()(PUBLIC_TABLE_QUERIES.find)).pages;
    const pages = result.nodes.filter(p=>p.handle===handle);
    if (pages.length !== 1 || result.pageInfo.hasNextPage) throw new Error('Δεν βρέθηκε μοναδική σελίδα Shipping & Returns.');
    return pages[0];
  }
  async function freshRates(config) {
    const groups=new Map();for (const row of config.cells) for (const c of row) if (c) groups.set(JSON.stringify([c.profileId,c.groupId]),c);
    const rows=[];for (const c of groups.values()) rows.push(...await shippingRates(shippingGraphql(),{id:c.profileId,name:'Shipping profile',profileLocationGroups:[{locationGroup:{id:c.groupId}}]}));
    return rows;
  }
  function state() {
    for (const [id,p] of plans) if (p.expires < Date.now()) plans.delete(id);
    return { config:store.get('publicTableConfig'),page:store.get('publicTablePage'),lastPublished:store.get('publicTablePublished') };
  }
  async function handleRequest(path,input) {
    if (path.endsWith('/load')) { const page = await findPage(); const info = pageInfo(page); store.put('publicTablePage',info); return info; }
    if (path.endsWith('/mapping')) {
      const saved = store.get('publicTablePage');
      if (!saved) throw new Error('Φόρτωσε πρώτα τον πίνακα της σελίδας.');
      const config = validateTableConfig(input,saved.table,true);
      store.put('publicTableConfig',config);plans.clear();return {ok:true};
    }
    if (path.endsWith('/preview')) {
      const page = await findPage(), table = currentTable(page.body), config = validateTableConfig(input,table);
      const built = buildPublicTable(await freshRates(config),config,table), body = replacePublicTable(page.body,built.matrix);
      const id = randomBytes(24).toString('hex'), expires = Date.now()+15*60000;
      plans.clear(); plans.set(id,{...built,page,body,expires});
      store.put('publicTableConfig',config); store.put('publicTablePage',pageInfo(page));
      return { id,expires,page:pageInfo(page),matrix:built.matrix,changed:body!==page.body };
    }
    if (path.endsWith('/publish')) {
      const plan = plans.get(input.id); plans.delete(input.id);
      if (!plan || plan.expires < Date.now()) throw new Error('Η προεπισκόπηση έληξε ή χρησιμοποιήθηκε. Κάνε νέα προεπισκόπηση.');
      const page = (await graphql()(PUBLIC_TABLE_QUERIES.page,{id:plan.page.id})).page;
      if (!page || hash(page)!==hash(plan.page)) throw new Error('Η σελίδα άλλαξε μετά την προεπισκόπηση. Φόρτωσε νέα προεπισκόπηση.');
      const fresh = buildPublicTable(await freshRates(plan.config),plan.config,currentTable(page.body));
      if (fresh.signature !== plan.signature) throw new Error('Οι χρεώσεις Shopify άλλαξαν. Φόρτωσε νέα προεπισκόπηση.');
      if (page.body === plan.body) return {ok:true,changed:false};
      store.put('publicTableBackup',{pageId:page.id,body:page.body,at:new Date().toISOString()});
      const audit = store.db.prepare('INSERT INTO audit(created,variant_id,title,old_price,new_price,status,detail,kind) VALUES (?,?,?,?,?,?,?,?)').run(new Date().toISOString(),page.id,page.title,0,0,'pending','Ενημέρωση πίνακα μεταφορικών','shipping_page');
      let sending = false;
      try {
        sending = true;
        const result = (await graphql()(PUBLIC_TABLE_QUERIES.update,{id:page.id,page:{body:plan.body}})).pageUpdate;
        if (result.userErrors.length) { sending=false; throw new Error(result.userErrors.map(e=>e.message).join('; ')); }
        const confirmed = (await graphql()(PUBLIC_TABLE_QUERIES.page,{id:page.id})).page;
        if (!confirmed || confirmed.body!==plan.body || confirmed.handle!==page.handle || confirmed.title!==page.title) throw new Error('Δεν επιβεβαιώθηκε η ενημέρωση της σελίδας. Έλεγξε το Shopify πριν δοκιμάσεις ξανά.');
        store.put('publicTablePage',pageInfo(confirmed)); store.put('publicTablePublished',new Date().toISOString());
        store.db.prepare("UPDATE audit SET status='success',detail='Ενημερώθηκαν μόνο οι τιμές του πίνακα' WHERE id=?").run(audit.lastInsertRowid);
        return {ok:true,changed:true};
      } catch (error) {
        store.db.prepare('UPDATE audit SET status=?,detail=? WHERE id=?').run(sending?'uncertain':'failed',safeError(error),audit.lastInsertRowid); throw error;
      }
    }
    throw new Error('Άγνωστη ενέργεια πίνακα ιστοσελίδας.');
  }
  return {state,handle:handleRequest};
}
