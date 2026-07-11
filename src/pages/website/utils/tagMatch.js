// Shared tag-generation logic — the single source of truth for "which
// tags exist for a restaurant and which items belong to each." Imported
// by BOTH the prerender loop (build time) and TagStaticRoute (client
// nav), so the two can never drift on tag membership.
//
// Pure: takes already-loaded flat arrays (same shape as useMenu AND the
// prerender's queries), returns generated tags. No fetch, no React.
//
// A tag generates where >=3 items match (photos NOT required — the tag
// page renders a full text item list, so it's content-rich regardless
// of photos; imaged items additionally get a photo carousel). The >=3
// gate still withholds genuinely thin pages.

// Resolve the generated tags for one restaurant, in allowlist order.
// - allowlist: the tag-keywords.json `tags` array [{ slug, label, match }]
// - categories: [{ id, name, ... }]
// - items:      [{ id, category_id, name, description, image_url, ... }]
// Returns: [{ def, items }] where def is the allowlist entry and items
// is the matched, imaged item set (>=3 guaranteed).
export function resolveGeneratedTags({ allowlist, categories, items }) {
  const out = []
  for (const def of (allowlist || [])) {
    const matchedCatIds = (categories || [])
      .filter((c) => def.match.some((m) => (c.name || '').toLowerCase().includes(m)))
      .map((c) => c.id)
    if (matchedCatIds.length === 0) continue
    const matched = (items || []).filter(
      (it) => matchedCatIds.includes(it.category_id)
    )
    if (matched.length < 3) continue // anti-thin-content gate
    out.push({ def, items: matched })
  }
  return out
}

// Build the sibling-tag chips for a given tag (the OTHER generated tags).
export function siblingTagsFor(generated, currentSlug, limit = 15) {
  return generated
    .filter((g) => g.def.slug !== currentSlug)
    .map((g) => ({ slug: g.def.slug, label: g.def.label }))
    .slice(0, limit)
}

// Attach nested item_sizes to a tag's items (cards read item.item_sizes
// for pricing). `getSizes(itemId)` returns the size rows. No cap: tag
// pages render the FULL matched set as the content spine (indexable
// text). Callers that need a bounded subset (e.g. a photo carousel)
// slice the result themselves.
export function withItemSizes(items, getSizes) {
  return (items || []).map((it) => ({
    ...it,
    item_sizes: getSizes(it.id),
  }))
}
