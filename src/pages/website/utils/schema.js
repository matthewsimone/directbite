// Pure schema.org JSON-LD builders for prerendered restaurant pages.
// No DOM / window / import.meta — build-time safe, mirrors seoHead.js.
// Callers pass NORMALIZED values (not raw DB rows) so these stay pure
// and unit-testable; field mapping lives at the call site.

// Strip null/undefined/'' so emitted JSON-LD carries no empty keys.
function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null && v !== '')
  )
}

// One menu item -> MenuItem + nested Offer.
// `price` is already resolved by the caller (base price, or a "from"
// price for sized items). Omit price -> no Offer emitted.
export function buildMenuItemSchema({ name, description, image, price, currency = 'USD' }) {
  const item = clean({
    '@type': 'MenuItem',
    name,
    description,
    image,
  })
  if (price != null && price !== '') {
    item.offers = clean({
      '@type': 'Offer',
      price: String(price),
      priceCurrency: currency,
      availability: 'https://schema.org/InStock',
    })
  }
  return item
}

// A list of menu items -> ItemList of MenuItems (tag pages, curated sets).
// `items`: array of the same shape buildMenuItemSchema accepts.
export function buildItemListSchema(items, { name } = {}) {
  const list = (items || []).map((it, i) => clean({
    '@type': 'ListItem',
    position: i + 1,
    item: buildMenuItemSchema(it),
  }))
  return clean({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: list.length,
    itemListElement: list,
  })
}
