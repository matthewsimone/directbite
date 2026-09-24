import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'

// 'menu', 'places' and 'tags' are live routes (App.jsx /:slug/menu, /places,
// /tags; CustomDomainShell /menu, /places, /tags) and they OUT-RANK the
// /:linkPath catch-all, so a link claiming one of those paths would silently
// render the SEO page instead of itself. They matter more now that page links
// exist, since "Menu" is the obvious label to reach for.
//
// 'sitemap.xml' and 'robots.txt' are deliberately absent: PATH_RE rejects dots,
// so neither can ever be entered.
const RESERVED_PATHS = ['home', 'checkout', 'confirmation', 'tablet', 'order', 'admin', 'privacy', 'terms', 'applepay-test', 'login', 'menu', 'places', 'tags']
const PATH_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Absent type reads as 'pdf', absent/blank group as ungrouped — the same rules
// the website side applies in pages/website/utils/websiteLinks.js. Duplicated
// rather than imported: this is a tablet file, and the two are three lines
// each; if the meaning of an absent key ever changes, change it in both.
function typeOf(link) {
  const raw = link && typeof link.type === 'string' ? link.type : ''
  return raw === 'page' || raw === 'category' ? raw : 'pdf'
}
function groupOf(link) {
  return link && typeof link.group === 'string' ? link.group.trim() : ''
}

// Index of the nearest link in `dir` that shares list[i]'s group, or -1.
// Reordering is per-group: the arrows move a link within its own dropdown and
// leave every other group where it sits. Without this, a swap with a raw
// adjacent element would move links ACROSS group boundaries — silently
// re-grouping them, because grouping is derived from the `group` string and
// the array order only decides position.
function groupNeighborIndex(list, i, dir) {
  const key = groupOf(list[i])
  if (dir === 'up') {
    for (let k = i - 1; k >= 0; k--) if (groupOf(list[k]) === key) return k
  } else {
    for (let k = i + 1; k < list.length; k++) if (groupOf(list[k]) === key) return k
  }
  return -1
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `lnk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default function WebsiteLinksEditor({ restaurant, setRestaurant }) {
  const [links, setLinks] = useState(() => Array.isArray(restaurant?.website_links) ? restaurant.website_links : [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const slug = restaurant?.slug

  // Menu categories, for the picker a 'category' link shows instead of an
  // upload. Fetched once per restaurant — nothing else on this screen needs
  // them, and they are small (id + name). A failed load leaves the list empty,
  // which the picker reports rather than silently offering no options.
  const [categories, setCategories] = useState([])
  useEffect(() => {
    if (!restaurant?.id) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('menu_categories')
        .select('id, name')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order')
      if (cancelled) return
      if (error) {
        console.error('[WebsiteLinksEditor] category load failed', error.message)
        return
      }
      setCategories(data || [])
    })()
    return () => { cancelled = true }
  }, [restaurant?.id])

  function updateLink(id, patch) {
    setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }
  function onLabelChange(id, label) {
    setLinks((prev) => prev.map((l) => {
      if (l.id !== id) return l
      const next = { ...l, label }
      if (!l.path) next.path = slugify(label)
      return next
    }))
  }
  function addLink() {
    setLinks((prev) => [...prev, { id: genId(), label: '', path: '', href: '' }])
  }
  function removeLink(id) {
    setLinks((prev) => prev.filter((l) => l.id !== id))
  }
  function move(id, dir) {
    setLinks((prev) => {
      const i = prev.findIndex((l) => l.id === id)
      if (i < 0) return prev
      const j = groupNeighborIndex(prev, i, dir)
      if (j < 0) return prev // no same-group neighbor that way — the arrow is disabled too
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  function validate() {
    const seen = new Set()
    for (const l of links) {
      const label = (l.label || '').trim()
      const path = (l.path || '').trim().toLowerCase()
      const type = typeOf(l)
      const href = (l.href || '').trim()
      const named = label || 'This link'
      if (!label) return 'Each link needs a label.'
      if (!path) return `"${named}" needs a URL path.`
      // href is required for BOTH types, but it means different things: an
      // uploaded PDF, or the internal route a page link opens.
      if (type === 'pdf' && !href) return `"${named}" is a PDF link — upload a PDF for it.`
      if (type === 'page') {
        if (!href) return `"${named}" is a page link — enter the page it opens, like /menu.`
        if (!href.startsWith('/')) return `"${named}" must open an internal path starting with "/" — for example /menu.`
      }
      if (type === 'category' && !href) return `"${named}" is a category link — choose the menu category it opens.`
      if (!PATH_RE.test(path)) return `Path "${path}" can only use lowercase letters, numbers, and hyphens.`
      if (RESERVED_PATHS.includes(path)) return `"${path}" is a reserved path — choose another.`
      if (seen.has(path)) return `Duplicate path "${path}". Each link needs a unique path.`
      seen.add(path)
    }
    return null
  }
  async function saveLinks() {
    const err = validate()
    if (err) { toast.error(err); return }
    // This rebuilds every element from a named whitelist on EVERY save, so a
    // key missing here is stripped from rows that were previously fine — not
    // just from the row being edited. type and group must be carried.
    //
    // Absence is written as absence: `type` is omitted when it is 'pdf' and
    // `group` when it is blank, so a link with neither key round-trips to the
    // exact same four-key object it is today.
    const clean = links.map((l) => {
      const type = typeOf(l)
      const group = groupOf(l)
      const out = { id: l.id, label: l.label.trim(), path: l.path.trim().toLowerCase(), href: (l.href || '').trim() }
      if (type !== 'pdf') out.type = type
      if (group) out.group = group
      return out
    })
    setSaving(true); setSaved(false)
    const { data, error } = await supabase.from('restaurants').update({ website_links: clean }).eq('id', restaurant.id).select().single()
    setSaving(false)
    if (error || !data) { toast.error("Couldn't save links. Try again."); return }
    setRestaurant(data)
    setLinks(Array.isArray(data.website_links) ? data.website_links : clean)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Menus & Links</h3>
      <p className="text-xs text-gray-400">Add PDF menus or info pages to your website navigation (e.g. Catering Menu, Lunch Specials).</p>
      {links.length === 0 && <p className="text-sm text-gray-400">No links yet.</p>}
      <div className="space-y-4">
        {links.map((link, idx) => {
          const type = typeOf(link)
          const group = groupOf(link)
          // Arrows reorder WITHIN a group, so they are live only when this link
          // has a same-group neighbor in that direction — not merely when it is
          // off the ends of the array.
          const canMoveUp = groupNeighborIndex(links, idx, 'up') >= 0
          const canMoveDown = groupNeighborIndex(links, idx, 'down') >= 0
          return (
          <div key={link.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">
                Link {idx + 1}
                {group && <span className="ml-2 text-gray-400">· {group}</span>}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => move(link.id, 'up')} disabled={!canMoveUp} className="px-2 py-1 text-gray-500 disabled:opacity-30" aria-label="Move up">↑</button>
                <button onClick={() => move(link.id, 'down')} disabled={!canMoveDown} className="px-2 py-1 text-gray-500 disabled:opacity-30" aria-label="Move down">↓</button>
                <button onClick={() => removeLink(link.id)} className="px-2 py-1 text-red-500 text-sm" aria-label="Remove">Remove</button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Label (shown in nav)</label>
              <input type="text" value={link.label} onChange={(e) => onLabelChange(link.id, e.target.value)} placeholder="Catering Menu" className="w-full h-11 px-3 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">URL path</label>
              <div className="flex items-center">
                <span className="text-sm text-gray-400 mr-1">/</span>
                <input type="text" value={link.path} onChange={(e) => updateLink(link.id, { path: e.target.value })} placeholder="catering" className="flex-1 h-11 px-3 border border-gray-300 rounded-lg text-sm" />
              </div>
              <p className="text-xs text-gray-400 mt-1">Appears at {restaurant?.custom_domain || 'yoursite.com'}/{link.path || 'catering'}</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Type</label>
              <div className="flex gap-2">
                {[
                  { value: 'pdf', label: 'PDF' },
                  { value: 'page', label: 'Page' },
                  { value: 'category', label: 'Category' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    // Switching type clears href: a storage URL is not an
                    // internal path and vice versa, so carrying it across would
                    // leave a value that passes neither validation.
                    onClick={() => updateLink(link.id, { type: opt.value === 'pdf' ? undefined : opt.value, href: '' })}
                    className={`flex-1 h-11 rounded-lg text-sm font-medium border transition-colors ${
                      type === opt.value
                        ? 'bg-[#16A34A] text-white border-[#16A34A]'
                        : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {type === 'pdf' && 'Shows an uploaded PDF on its own page.'}
                {type === 'page' && 'Links straight to a page your site already has.'}
                {type === 'category' && 'Opens the ordering menu at this category.'}
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Group</label>
              <input type="text" value={link.group || ''} onChange={(e) => updateLink(link.id, { group: e.target.value })} placeholder="optional — links sharing a group become a dropdown" className="w-full h-11 px-3 border border-gray-300 rounded-lg text-sm" />
            </div>
            {type === 'pdf' && (
              <div>
                <label className="text-xs text-gray-400 mb-1 block">PDF</label>
                <ImageUpload accept="pdf" maxSizeMB={10} currentImageUrl={link.href} bucketName="restaurant-files" storagePath={`${slug}/${link.id}.pdf`} onUpload={(url) => updateLink(link.id, { href: url })} placeholder={link.href ? 'Replace PDF' : 'Upload PDF'} />
              </div>
            )}
            {type === 'page' && (
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Opens</label>
                <input type="text" value={link.href || ''} onChange={(e) => updateLink(link.id, { href: e.target.value })} placeholder="/menu" className="w-full h-11 px-3 border border-gray-300 rounded-lg text-sm" />
                <p className="text-xs text-gray-400 mt-1">A page on this site, starting with “/” — for example /menu.</p>
              </div>
            )}
            {type === 'category' && (
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Category</label>
                <select
                  value={link.href || ''}
                  onChange={(e) => updateLink(link.id, { href: e.target.value })}
                  className="w-full h-11 px-3 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">Choose a category…</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                  {/* A category saved earlier and since deleted would otherwise
                      vanish from the select, silently resetting the link to
                      blank on the next save. Keep it visible and named. */}
                  {link.href && !categories.some((c) => c.id === link.href) && (
                    <option value={link.href}>Category no longer on the menu</option>
                  )}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  {categories.length === 0
                    ? 'No menu categories found for this restaurant.'
                    : 'Opens the ordering menu scrolled to this category.'}
                </p>
              </div>
            )}
          </div>
          )
        })}
      </div>
      <button onClick={addLink} className="w-full h-11 border border-dashed border-gray-300 text-gray-600 font-medium rounded-xl hover:bg-gray-50 transition-colors">+ Add Link</button>
      <button onClick={saveLinks} disabled={saving} className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors">{saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}</button>
    </div>
  )
}
