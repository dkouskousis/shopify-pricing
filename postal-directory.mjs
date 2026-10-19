import { inflateRawSync } from 'node:zlib';
import { destinations } from './public/shipping-sample.mjs';
export const directoryState = store => ({ ...destinations, ...(store.get('postalDirectory') ?? {}) });
const normal = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function editDestination(input, previous) {
  if (!previous || typeof input.city !== 'string' || !input.city.trim() || input.city.length > 100 || /[\x00-\x1f]/.test(input.city) || typeof input.postalCode !== 'string' || input.postalCode.length > 20 || /[\x00-\x1f]/.test(input.postalCode) || typeof input.noPostalCode !== 'boolean' || (!input.noPostalCode && !input.postalCode.trim())) throw new Error('Συμπλήρωσε πόλη και ΤΚ ή επίλεξε ότι δεν χρησιμοποιείται ΤΚ.');
  return { ...previous, city: input.city.trim(), postalCode: input.noPostalCode ? '' : input.postalCode.trim(), noPostalCode: input.noPostalCode, source: '', manual: true, updatedAt: new Date().toISOString(), error: '' };
}
// Read the named text member, never extract files to disk. Bound both download and inflation.
export function postalText(zip, code) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Μη έγκυρο αρχείο ταχυδρομικών κωδικών.');
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) break;
    const size = zip.readUInt32LE(offset + 20), expanded = zip.readUInt32LE(offset + 24), n = zip.readUInt16LE(offset + 28), x = zip.readUInt16LE(offset + 30), c = zip.readUInt16LE(offset + 32);
    if (zip.subarray(offset + 46, offset + 46 + n).toString() === code + '.txt') {
      const local = zip.readUInt32LE(offset + 42), method = zip.readUInt16LE(offset + 10);
      if (expanded > 32 * 1024 * 1024 || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50 || (zip.readUInt16LE(offset + 8) & 1)) break;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + size > zip.length) break;
      const bytes = zip.subarray(start, start + size);
      if (method === 0 && bytes.length === expanded) return bytes.toString('utf8');
      if (method === 8) { const out = inflateRawSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }); if (out.length === expanded) return out.toString('utf8'); }
      break;
    }
    offset += 46 + n + x + c;
  }
  throw new Error('Δεν βρέθηκε έγκυρη λίστα ΤΚ για τη χώρα.');
}
async function download(url, fetcher, maxBytes) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: '*/*' } });
  if (!response.ok) throw new Error(`Η online πηγή επέστρεψε HTTP ${response.status}.`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) { throw new Error('Η online πηγή υπερβαίνει το όριο μεγέθους.'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function countryList(fetcher = fetch) {
  const data = (await download('https://download.geonames.org/export/dump/countryInfo.txt', fetcher, 256000)).toString();
  const rows = data.split('\n').filter(l => !l.startsWith('#')).map(l => l.split('\t')).filter(f => /^[A-Z]{2}$/.test(f[0]) && f[4] && !['AN','CS'].includes(f[0]));
  if (rows.length < 200) throw new Error('Η online λίστα χωρών είναι ελλιπής.');
  return Object.fromEntries(rows.map(f => [f[0], { name: f[4], city: f[5].trim(), postalCode: '', noPostalCode: false, source: 'https://download.geonames.org/export/dump/countryInfo.txt', updatedAt: null }]));
}
const aliases = { AT:['Wien'], BE:['Bruxelles','Brussel'], CH:['Berne'], CZ:['Praha'], DK:['København'], ES:['Madrid'], FI:['Helsinki'], GR:['Athina','Athens'], IS:['Reykjavík'], IT:['Roma'], JP:['Tokyo','Shibuya'], PL:['Warszawa'], PT:['Lisboa'], SE:['Stockholm'], SK:['Bratislava'], BD:['Dhaka GPO'], US:['Washington'] };
export async function refreshDestination(code, entry, fetcher = fetch) {
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('Μη έγκυρη χώρα.');
  const source = `https://www.gstatic.com/chrome/autofill/libaddressinput/chromium-i18n/ssl-address/data/${code}`;
  const format = JSON.parse((await download(source, fetcher, 128000)).toString());
  if (format.key !== code || typeof format.fmt !== 'string') throw new Error('Δεν βρέθηκε έγκυρη μορφή διεύθυνσης για τη χώρα.');
  const updatedAt = new Date().toISOString();
  if (!format.fmt.includes('%Z')) return { ...entry, postalCode: '', noPostalCode: true, source, updatedAt, manual: false, error: '' };
  if (!entry.city) throw new Error('Δεν υπάρχει πρωτεύουσα. Όρισε πόλη χειροκίνητα.');
  const zipSource = `https://download.geonames.org/export/zip/${code}.zip`;
  const data = postalText(await download(zipSource, fetcher, 10 * 1024 * 1024), code);
  // Country formats reject truncated codes (e.g. Canadian FSA and British outward code).
  const pattern = format.zip ? new RegExp('^(?:' + format.zip.replaceAll('\\\\', '\\') + ')$') : null;
  const cities = [entry.city, ...(aliases[code] ?? [])].map(normal);
  const matches = data.split('\n').map(l => l.split('\t')).filter(f => f[0] === code && cities.includes(normal(f[2] ?? '')) && f[1] && f[1].length <= 20 && (!pattern || pattern.test(f[1])) && (code !== 'US' || f[4] === 'DC') && (code !== 'ES' || f[1].startsWith('28')));
  if (!matches.length) throw new Error('Δεν βρέθηκε πλήρης ΤΚ που να αντιστοιχεί στην πόλη. Η υπάρχουσα εγγραφή διατηρήθηκε.');
  const existing = matches.find(f => f[1] === entry.postalCode);
  if (!existing && new Set(matches.map(f => `${f[4] ?? ''}/${f[6] ?? ''}`)).size > 1) throw new Error('Υπάρχουν ομώνυμες πόλεις σε διαφορετικές περιοχές. Όρισε τον σωστό ΤΚ χειροκίνητα.');
  const match = existing ?? matches.sort((a,b) => a[1].localeCompare(b[1]))[0];
  return { ...entry, postalCode: match[1], noPostalCode: false, source: zipSource, updatedAt, manual: false, error: '' };
}
