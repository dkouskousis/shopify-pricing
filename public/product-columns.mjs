export const PRODUCT_COLUMNS=[
  {id:'select',label:'Επιλογή',required:true}, {id:'product',label:'Προϊόν / παραλλαγή',required:true},
  {id:'status',label:'Κατάσταση'}, {id:'inventory',label:'Συνολικό απόθεμα'}, {id:'weight',label:'Βάρος (kg)'},
  {id:'cost',label:'Αγορά χωρίς ΦΠΑ'}, {id:'price',label:'Product Price'}, {id:'newPrice',label:'Νέα τιμή'},
  {id:'gain',label:'Κέρδος %'}, {id:'fixed',label:'Σταθερό ποσό'}, {id:'vat',label:'ΦΠΑ'},
  {id:'profit',label:'Μικτό κέρδος (€)'}, {id:'margin',label:'Μικτό περιθώριο (%)'}, {id:'actions',label:'Ενέργειες'},
];
export function columnPreferences(input=null){
  if(input===null)return {order:PRODUCT_COLUMNS.map(c=>c.id),hidden:[],widths:{}};
  const ids=PRODUCT_COLUMNS.map(c=>c.id);
  if(!Array.isArray(input.order)||input.order.length!==ids.length||new Set(input.order).size!==ids.length||input.order.some(id=>!ids.includes(id))||input.order[0]!=='select')throw new Error('Μη έγκυρη σειρά στηλών.');
  if(!Array.isArray(input.hidden)||new Set(input.hidden).size!==input.hidden.length||input.hidden.some(id=>!ids.includes(id)||PRODUCT_COLUMNS.find(c=>c.id===id).required))throw new Error('Η επιλογή και το προϊόν πρέπει να εμφανίζονται πάντα.');
  const widths=input.widths??{};
  if(!widths||typeof widths!=='object'||Array.isArray(widths)||Object.entries(widths).some(([id,w])=>!ids.includes(id)||!Number.isInteger(w)||w<48||w>1200))throw new Error('Το πλάτος στήλης πρέπει να είναι από 48 έως 1.200 px.');
  return {order:[...input.order],hidden:[...input.hidden],widths:{...widths}};
}
