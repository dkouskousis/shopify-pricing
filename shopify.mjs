import { setTimeout as delay } from 'node:timers/promises';

export const QUERIES = {
  collections: `query PricingCollections($after: String) {
    collections(first: 250, after: $after) { nodes { id title } pageInfo { hasNextPage endCursor } }
  }`,
  memberships: `query PricingMemberships($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id collections(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } }
  }`,
  productCollections: `query PricingProductCollections($id: ID!, $after: String) {
    product(id: $id) { collections(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
  }`,
  shop: `query ShopInfo { shop { name myshopifyDomain currencyCode } }`,
  variants: `query PricingVariants($after: String) {
    productVariants(first: 100, after: $after) {
      nodes { id title price compareAtPrice taxable
        inventoryItem { sku unitCost { amount currencyCode } }
        product { id title vendor status
          featuredMedia { preview { image { altText thumbnail: url(transform: {maxWidth: 80, maxHeight: 80}) url(transform: {maxWidth: 1600, maxHeight: 1600}) } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  check: `query CurrentPricingVariant($id: ID!) {
    productVariant(id: $id) { id price compareAtPrice taxable
      inventoryItem { id unitCost { amount currencyCode } }
      product { id vendor status }
    }
  }`,
  update: `mutation UpdatePricingVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }`,
  updateCost: `mutation UpdatePricingCost($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id unitCost { amount currencyCode } }
      userErrors { field message }
    }
  }`,
};
export async function collectionPages(fetchPage, firstPage = null) {
  const all = [], cursors = new Set();
  let after = null, page = firstPage;
  do {
    if (!page) page = await fetchPage(after);
    all.push(...page.nodes);
    if (all.length > 25000) throw new Error('Υπέρβαση ορίου 25.000 collections.');
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error('Μη έγκυρος cursor collections από το Shopify.');
    cursors.add(after); page = null;
  } while (true);
  return all;
}
export async function productCollectionIds(api, id, firstPage = null) {
  const nodes = await collectionPages(async after => {
    const { product } = await api(QUERIES.productCollections, { id, after });
    if (!product) throw new Error('Το προϊόν δεν υπάρχει πλέον στο Shopify.');
    return product.collections;
  }, firstPage);
  return [...new Set(nodes.map(c => c.id))].sort();
}
export function validateSettings(input, previous = {}) {
  const shop = String(input.shop ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Βάλε το πλήρες domain καταστήματος, π.χ. example.myshopify.com, χωρίς https://.');
  if (previous.shop && previous.shop !== shop) throw new Error('Η αλλαγή καταστήματος απαιτεί ξεχωριστή εγκατάσταση, ώστε να μη συνδυαστούν δεδομένα διαφορετικών καταστημάτων.');
  if (!['client_credentials', 'access_token'].includes(input.mode)) throw new Error('Μη έγκυρος τρόπος σύνδεσης.');
  const s = { shop, mode: input.mode, clientId: String(input.clientId ?? '').trim() };
  for (const key of ['clientSecret', 'accessToken']) {
    if (typeof input[key] !== 'string') throw new Error('Μη έγκυρα στοιχεία σύνδεσης.');
    s[key] = input[key].trim() || previous[key] || '';
    if (s[key].length > 4096) throw new Error('Μη έγκυρα στοιχεία σύνδεσης.');
  }
  if (s.mode === 'client_credentials' && (!s.clientId || !s.clientSecret)) throw new Error('Συμπλήρωσε Client ID και Client secret.');
  if (s.mode === 'access_token' && !s.accessToken) throw new Error('Συμπλήρωσε Admin API access token.');
  return s;
}
export function createShopify(settings, fetcher = fetch) {
  let token = '', expiresAt = 0, nextRequestAt = 0;
  async function getToken() {
    if (settings.mode === 'access_token') return settings.accessToken;
    if (token && Date.now() < expiresAt) return token;
    const response = await fetcher(`https://${settings.shop}/admin/oauth/access_token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: settings.clientId, client_secret: settings.clientSecret }),
    });
    if (!response.ok) throw new Error(`Shopify authentication: HTTP ${response.status}. Έλεγξε εγκατάσταση εφαρμογής και credentials.`);
    const result = await response.json();
    if (!result.access_token || !result.expires_in) throw new Error('Μη έγκυρη απάντηση πιστοποίησης Shopify.');
    token = result.access_token;
    expiresAt = Date.now() + (result.expires_in - 120) * 1000;
    return token;
  }
  return async function graphql(query, variables = {}, version = '2026-10') {
    if (!['2026-10', 'unstable'].includes(version)) throw new Error('Μη υποστηριζόμενη έκδοση Shopify API.');
    if (nextRequestAt > Date.now()) await delay(nextRequestAt - Date.now());
    const response = await fetcher(`https://${settings.shop}/admin/api/${version}/graphql.json`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Shopify API: HTTP ${response.status}. Έλεγξε δικαιώματα ή δοκίμασε ξανά αργότερα.`);
    const result = await response.json();
    const cost = result.extensions?.cost;
    if (cost?.throttleStatus?.restoreRate > 0) {
      const needed = Math.max(0, cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable);
      nextRequestAt = Date.now() + Math.ceil(needed / cost.throttleStatus.restoreRate * 1000);
    }
    if (result.errors?.length) throw new Error(`Shopify: ${result.errors.map(e => e.message).join('; ').slice(0, 800)}`);
    if (!result.data) throw new Error('Το Shopify δεν επέστρεψε δεδομένα.');
    return result.data;
  };
}
