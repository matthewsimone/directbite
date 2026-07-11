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

// A full restaurant Menu -> Menu > hasMenuSection[] > hasMenuItem[].
// `sections`: [{ name, items: [{ name, description, image, price }] }].
// Sections with zero items are dropped. Items reuse buildMenuItemSchema.
export function buildMenuSchema({ name, sections } = {}) {
  const hasMenuSection = (sections || [])
    .map((sec) => {
      const items = (sec.items || []).map(buildMenuItemSchema)
      if (items.length === 0) return null
      return clean({
        '@type': 'MenuSection',
        name: sec.name,
        hasMenuItem: items,
      })
    })
    .filter(Boolean)
  return clean({
    '@context': 'https://schema.org',
    '@type': 'Menu',
    name,
    hasMenuSection,
  })
}

// Serialize a schema object into a ready-to-inject <script> tag.
// Hardens against tag-breakout: any '<' inside the JSON (e.g. an item
// named "Fish <3" or a stray "</script>") becomes the literal escape
// < (backslash-u-003c), which is a
// valid JSON escape AND cannot terminate the script element or open a
// comment. This is why menu JSON-LD must NOT go through the HTML-entity
// escapeHtml path (that would corrupt the JSON).
export function schemaScriptTag(schema) {
  const json = JSON.stringify(schema).replace(/</g, '\\u003c')
  return `<script type="application/ld+json">${json}</script>`
}

// FAQPage -> mainEntity[Question -> acceptedAnswer[Answer]].
// `qas`: [{ q, a }]. Entries with an empty q or a are dropped, so a
// caller can conditionally build a list and let empties fall away
// (e.g. omit the delivery Q on non-delivery pages by passing a='').
export function buildFaqSchema(qas) {
  const mainEntity = (qas || [])
    .filter((x) => x && x.q && x.a)
    .map((x) => ({
      '@type': 'Question',
      name: x.q,
      acceptedAnswer: { '@type': 'Answer', text: x.a },
    }))
  if (mainEntity.length === 0) return null
  return clean({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity,
  })
}
