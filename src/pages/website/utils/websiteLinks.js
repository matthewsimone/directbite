// ============================================================================
// restaurants.website_links — shape rules, in one place.
// ============================================================================
//
// An element is { id, label, path, href } plus two OPTIONAL keys:
//
//   type   'pdf' | 'page' | 'category'   absent = 'pdf'
//   group  string           absent/blank = not grouped (a flat nav link)
//
// Absence is the default in both cases, and the editor writes absence as
// absence — it omits `type` when it is 'pdf' and omits `group` when it is
// blank, rather than storing explicit defaults. Every element written before
// these keys existed therefore keeps behaving exactly as it did, and this
// module is the only place that decides what an absent key means.
//
// A 'pdf' link's href is an uploaded PDF in Supabase Storage, and its `path`
// is a route LinkViewer renders it at. A 'page' link's href is an INTERNAL
// route that already exists (e.g. '/menu'); the nav links straight there and
// LinkViewer is never its destination. A 'category' link's href is a
// menu_categories.id, and it opens the ORDERING page scrolled to that section —
// the whole menu still renders, only the landing position differs.

import { getOrderUrl } from '../../../lib/customDomain'

// Absent, unknown, or malformed type reads as 'pdf' — the value every existing
// row has by omission. An unrecognised string falls back to 'pdf' too, so a
// future type written by a newer client degrades to today's behavior rather
// than rendering nothing.
export function linkType(link) {
  const raw = link && typeof link.type === 'string' ? link.type : ''
  return raw === 'page' || raw === 'category' ? raw : 'pdf'
}

// Normalized group name, or '' for "not grouped". Whitespace-only is blank:
// a group of '   ' must not become a dropdown labeled with spaces.
export function linkGroup(link) {
  const raw = link && typeof link.group === 'string' ? link.group.trim() : ''
  return raw
}

// Where a nav entry for this link should point, given the site's link base
// (`/${slug}` on the main domain, '' on a custom domain) and the restaurant's
// slug (needed only by category links — see below).
//
// A page link's href is already a route path, so it is appended to the base as
// written; a leading slash is added if the operator omitted one. A pdf link
// keeps today's `${base}/${path}` target, which LinkViewer serves. Both stay
// relative and are navigated by react-router.
//
// A category link is the one that leaves the website: ordering lives on the
// MAIN domain, so from a custom-domain site this has to cross origins. That is
// exactly what getOrderUrl already decides for every Order button on the site,
// so it is reused rather than rebuilt here — it returns a relative path on the
// main domain and an absolute https URL on a custom domain. `base` cannot
// stand in for the slug, because base is '' on a custom domain.
//
// Callers must therefore test the result with isExternalTarget before choosing
// between <Link> and <a>.
export function websiteLinkTarget(link, base, slug) {
  const type = linkType(link)
  const href = link && typeof link.href === 'string' ? link.href.trim() : ''

  if (type === 'category') {
    return getOrderUrl(slug, `?category=${encodeURIComponent(href)}`)
  }
  if (type === 'page') {
    const path = href.startsWith('/') ? href : `/${href}`
    return `${base}${path}`
  }
  return `${base}/${link.path}`
}

// True when a target crosses origins and must be rendered as a plain <a>.
// react-router's <Link> is for in-app paths; handing it an absolute URL to
// another host is not a navigation it owns. Mirrors the split OrderLink makes.
export function isExternalTarget(target) {
  return typeof target === 'string' && /^https?:\/\//i.test(target)
}

/**
 * Order the raw website_links array into what the nav actually renders.
 *
 * Returns a flat, ordered list of entries, each either:
 *
 *   { kind: 'link',  link }                 — ungrouped, renders as a flat link
 *   { kind: 'group', name, links: [...] }   — renders as a dropdown
 *
 * Array order is preserved: a group occupies the position of its FIRST member,
 * and members keep their relative order within it. So an operator reordering
 * the array in the editor reorders the nav the same way, and a group cannot
 * jump the queue by having a later member.
 *
 * A group with a single member is still a group — the operator named it, and
 * collapsing it to a flat link would make the nav change shape as they add the
 * second one. Callers that want different treatment can check links.length.
 *
 * Elements without a path are dropped: they cannot be linked to, and the nav
 * previously keyed on link.path, so a pathless element was already broken here.
 */
export function groupWebsiteLinks(links) {
  if (!Array.isArray(links)) return []

  const entries = []
  const byName = new Map()

  for (const link of links) {
    if (!link || !link.path) continue

    const name = linkGroup(link)
    if (!name) {
      entries.push({ kind: 'link', link })
      continue
    }

    const existing = byName.get(name)
    if (existing) {
      existing.links.push(link)
      continue
    }

    // First member of this group — it claims the group's position in the nav.
    const entry = { kind: 'group', name, links: [link] }
    byName.set(name, entry)
    entries.push(entry)
  }

  return entries
}
