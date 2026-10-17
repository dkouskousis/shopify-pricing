import { decimal } from './pricing.mjs';
const text = (value, name, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`Συμπλήρωσε σωστά: ${name}.`);
  return value.trim();
};
export function validateDhlSettings(input, previous = {}) {
  if (!['test', 'live'].includes(input.environment)) throw new Error('Επίλεξε περιβάλλον DHL.');
  const s = { environment: input.environment, username: text(input.username, 'DHL API username', 200),
    password: text(input.password || previous.password, 'DHL API password', 4096),
    accountNumber: text(input.accountNumber, 'DHL account number', 20),
    originCountryCode: text(input.originCountryCode, 'Χώρα αποστολέα', 2).toUpperCase(),
    originPostalCode: text(input.originPostalCode, 'ΤΚ αποστολέα', 20), originCityName: text(input.originCityName, 'Πόλη αποστολέα') };
  if (!/^\d{9}$/.test(s.accountNumber) || !/^[A-Z]{2}$/.test(s.originCountryCode) || s.username.includes(':')) throw new Error('Έλεγξε τον 9ψήφιο αριθμό λογαριασμού, τη χώρα και το API username της DHL.');
  return s;
}
export function validateShipment(input) {
  const s = { destinationCountryCode: text(input.destinationCountryCode, 'Χώρα παραλήπτη', 2).toUpperCase(),
    destinationPostalCode: text(input.destinationPostalCode, 'ΤΚ παραλήπτη', 20), destinationCityName: text(input.destinationCityName, 'Πόλη παραλήπτη'),
    plannedShippingDate: text(input.plannedShippingDate, 'Ημερομηνία αποστολής', 10), isCustomsDeclarable: input.isCustomsDeclarable };
  if (!/^[A-Z]{2}$/.test(s.destinationCountryCode) || typeof s.isCustomsDeclarable !== 'boolean') throw new Error('Έλεγξε χώρα και τελωνειακή δήλωση.');
  const date = new Date(s.plannedShippingDate + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.plannedShippingDate) || !Number.isFinite(+date) || date.toISOString().slice(0,10) !== s.plannedShippingDate || s.plannedShippingDate < new Date().toISOString().slice(0,10)) throw new Error('Βάλε έγκυρη σημερινή ή μελλοντική ημερομηνία.');
  for (const key of ['weight','length','width','height']) {
    const n = Number(String(input[key]).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > 1000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6 || (key !== 'weight' && n < 1)) throw new Error(`Μη έγκυρο ${key}: κιλά / εκατοστά, έως 3 δεκαδικά.`);
    s[key] = n;
  }
  return s;
}
export function createDhl(settings, fetcher = fetch) {
  return async input => {
    const sample = validateShipment(input);
    const params = new URLSearchParams({ accountNumber: settings.accountNumber,
      originCountryCode: settings.originCountryCode, originPostalCode: settings.originPostalCode, originCityName: settings.originCityName,
      ...sample, unitOfMeasurement: 'metric' });
    const base = 'https://express.api.dhl.com/mydhlapi' + (settings.environment === 'test' ? '/test' : '');
    const response = await fetcher(`${base}/rates?${params}`, { redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(settings.username + ':' + settings.password).toString('base64') } });
    if (!response.ok) throw new Error(`DHL Express: HTTP ${response.status}. Έλεγξε API credentials, λογαριασμό και στοιχεία αποστολής.`);
    const data = await response.json();
    const products = (data.products ?? []).map(p => {
      const billing = p.totalPrice?.filter(t => t.currencyType === 'BILLC' && t.priceCurrency === 'EUR');
      if (billing?.length !== 1) return null;
      const amount = decimal(String(billing[0].price));
      return { code: p.productCode, name: p.productName, price: amount, currency: 'EUR', weight: p.weight ?? null };
    }).filter(p => p && p.price >= 0 && typeof p.code === 'string' && typeof p.name === 'string');
    if (!products.length) throw new Error('Δεν επιστράφηκε προσφορά DHL σε EUR billing currency για αυτή την αποστολή.');
    return { products, sample, environment: settings.environment, at: new Date().toISOString() };
  };
}
