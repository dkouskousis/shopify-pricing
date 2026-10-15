export function filterProducts(products, { search, vendor, change, status, price }) {
  const query = search.trim().toLocaleLowerCase();
  return products.filter(p => {
    const hasPrice = Number.isFinite(p.price) && p.price > 0;
    return (!vendor || p.vendor === vendor)
      && (!query || `${p.title} ${p.variant} ${p.sku}`.toLocaleLowerCase().includes(query))
      && (status === 'all' || (status === 'active' ? p.status === 'ACTIVE' : p.status !== 'ACTIVE'))
      && (price === 'all' || (price === 'filled' ? hasPrice : !hasPrice))
      && (change === 'all' || (change === 'missing' ? Boolean(p.result.error) : !p.result.error && p.result.final !== p.price));
  });
}
