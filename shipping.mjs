import { decimal, money } from './pricing.mjs';
export const SHIPPING_QUERIES = {
  profiles: `query ShippingProfiles($after: String) { deliveryProfiles(first: 25, after: $after, merchantOwnedOnly: true) { nodes { id name profileLocationGroups { locationGroup { id } } } pageInfo { hasNextPage endCursor } } }`,
  zone: `query ShippingZone($id: ID!, $group: ID!, $after: String, $methodsAfter: String) {
    deliveryProfile(id: $id) { id name profileLocationGroups(locationGroupId: $group) {
      locationGroup { id } locationGroupZones(first: 1, after: $after) { edges { cursor node {
        zone { id name countries { name code { countryCode restOfWorld } } }
        methodDefinitions(first: 50, after: $methodsAfter) { nodes { id name active description
          methodConditions { id field operator conditionCriteria { ... on MoneyV2 { amount currencyCode } ... on Weight { value unit } } }
          rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } ... on DeliveryParticipant { id } }
        } pageInfo { hasNextPage endCursor } }
      } } pageInfo { hasNextPage endCursor } }
    } }
  }`,
  update: `mutation UpdateShippingPrice($id: ID!, $profile: DeliveryProfileInput!) { deliveryProfileUpdate(id: $id, profile: $profile) { profile { id } userErrors { field message } } }`,
};
function next(page, seen) {
  if (!page.pageInfo.hasNextPage) return null;
  const cursor = page.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw new Error('Μη έγκυρη σελιδοποίηση μεταφορικών Shopify.');
  seen.add(cursor); return cursor;
}
export async function shippingRates(api, onlyProfile = null) {
  const profiles = [], rows = []; let after = null; const seen = new Set();
  if (onlyProfile) profiles.push(onlyProfile);
  else do {
    const page = (await api(SHIPPING_QUERIES.profiles, { after })).deliveryProfiles;
    profiles.push(...page.nodes); after = next(page, seen);
    if (profiles.length > 1000) throw new Error('Πάρα πολλά προφίλ μεταφορικών.');
  } while (after);
  for (const profile of profiles) for (const { locationGroup: { id: group } } of profile.profileLocationGroups) {
    let zoneAfter = null; const zonesSeen = new Set();
    do {
      let methodsAfter = null, zonePage, zoneId = null; const methodsSeen = new Set();
      do {
        const data = (await api(SHIPPING_QUERIES.zone, { id: profile.id, group, after: zoneAfter, methodsAfter })).deliveryProfile;
        if (!data) throw new Error('Το προφίλ μεταφορικών άλλαξε. Κάνε νέο συγχρονισμό.');
        const location = data.profileLocationGroups.find(g => g.locationGroup.id === group);
        if (!location) throw new Error('Η ομάδα αποστολής άλλαξε. Κάνε νέο συγχρονισμό.');
        zonePage = location.locationGroupZones;
        const node = zonePage.edges[0]?.node; if (!node) break;
        if (zoneId && zoneId !== node.zone.id) throw new Error('Η ζώνη άλλαξε κατά την ανάγνωση.');
        zoneId = node.zone.id;
        for (const method of node.methodDefinitions.nodes) {
          const provider = method.rateProvider, fixed = provider.__typename === 'DeliveryRateDefinition';
          rows.push({ id: [profile.id, group, node.zone.id, method.id].join('|'), profileId: profile.id, profileName: profile.name,
            groupId: group, zoneId: node.zone.id, zoneName: node.zone.name, countries: node.zone.countries,
            methodId: method.id, name: method.name, active: method.active, description: method.description,
            conditions: method.methodConditions, providerId: provider.id, price: fixed ? decimal(provider.price.amount) : null,
            currency: fixed ? provider.price.currencyCode : null, editable: fixed && provider.price.currencyCode === 'EUR',
            type: provider.__typename });
        }
        if (rows.length > 10000) throw new Error('Υπέρβαση 10.000 κλιμάκων μεταφορικών.');
        methodsAfter = next(node.methodDefinitions, methodsSeen);
      } while (methodsAfter);
      zoneAfter = next(zonePage, zonesSeen);
    } while (zoneAfter);
  }
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Διπλές κλίμακες στο Shopify. Επανάλαβε τον συγχρονισμό.');
  return rows;
}
export function shippingFingerprint(row) { return JSON.stringify([row.profileId, row.groupId, row.zoneId, row.methodId, row.providerId, row.price, row.currency, row.active, row.conditions, row.countries]); }
export function shippingUpdate(row, price) {
  return { id: row.profileId, profile: { locationGroupsToUpdate: [{ id: row.groupId, zonesToUpdate: [{ id: row.zoneId,
    methodDefinitionsToUpdate: [{ id: row.methodId, rateDefinition: { id: row.providerId, price: { amount: money(price), currencyCode: 'EUR' } } }]
  }] }] } };
}
export function adjustedShippingPrice(price, kind, value) {
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('Μη έγκυρη βασική τιμή μεταφορικών.');
  const text = String(value).trim().replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Βάλε ποσό ή ποσοστό με έως δύο δεκαδικά.');
  const n = Number(text); if (!Number.isFinite(n) || Math.abs(n) > 100000) throw new Error('Μη έγκυρη προσαρμογή.');
  if (!['fixed', 'percent'].includes(kind)) throw new Error('Μη έγκυρος τρόπος προσαρμογής.');
  const final = kind === 'fixed' ? price + Math.round(n * 100) : Math.round(price * (1 + n / 100));
  if (!Number.isSafeInteger(final) || final < 0 || final > 100000000) throw new Error('Η νέα χρέωση πρέπει να είναι από 0 έως 1.000.000€.');
  return final;
}
