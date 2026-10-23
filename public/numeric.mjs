// Strip pasted currency, percent signs and spacing; retain letters and operators
// so malformed values cannot silently turn into a different valid amount.
export function cleanNumber(value){
  let text=String(value??'').replace(/[\s\p{Sc}%٪]/gu,'').replace(/−/g,'-');
  if(text.includes(',')&&text.includes('.')){
    const decimal=text.lastIndexOf(',')>text.lastIndexOf('.')?',':'.',group=decimal===','?'.':',';
    const parts=text.split(decimal);
    if(parts.length===2&&new RegExp('^[+-]?\\d{1,3}(?:\\'+group+'\\d{3})+$').test(parts[0])&&/^\d+$/.test(parts[1]))text=parts[0].split(group).join('')+'.'+parts[1];
  }else text=text.replace(',','.');
  return text;
}
export function installNumericCleanup(doc){
  const eligible=el=>el?.matches?.('input[inputmode="decimal"],input[data-edit-location],input[name="quantity"]');
  doc.addEventListener('paste',e=>{
    if(!eligible(e.target))return;
    const pasted=e.clipboardData?.getData('text');if(pasted===undefined)return;
    e.preventDefault();const el=e.target;el.setRangeText(cleanNumber(pasted),el.selectionStart,el.selectionEnd,'end');el.value=cleanNumber(el.value);el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  doc.addEventListener('change',e=>{if(eligible(e.target))e.target.value=cleanNumber(e.target.value);},true);
  doc.addEventListener('submit',e=>{for(const el of e.target.elements??[])if(eligible(el))el.value=cleanNumber(el.value);},true);
}
