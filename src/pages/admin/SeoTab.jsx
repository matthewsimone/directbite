import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { parseAddress } from '../website/utils/address'
import { findNearestTowns, MAX_RADIUS_MILES } from '../../lib/geoTowns'
import { resolveGeneratedTags } from '../website/utils/tagMatch'
import NJ_TOWNS from '../../data/nj-towns.json'
import TAG_KEYWORDS from '../../data/tag-keywords.json'

// Per-restaurant SEO overrides. Every field is OPTIONAL — blank means the
// prerender's auto-formula (see src/pages/website/utils/seoHead.js) generates
// the value. Saving a blank field writes NULL so the auto-formula kicks back in.
//
// Three sections:
//   1. Homepage SEO — cuisine/seo_title/seo_description on the restaurants table.
//   2. Location pages (/places) — one row per generated town, overrides in seo_pages.
//   3. Menu pages (/tags) — one row per generated dish tag, overrides in seo_pages.
// Sections 2 & 3 derive their row lists from the SAME shared functions the
// prerender uses (findNearestTowns + resolveGeneratedTags), so the admin edits
// exactly the pages that actually generate — no drift.

// ---- Auto-formula placeholders — mirror the prerender EXACTLY so the operator
// sees the TRUE auto value (the literal ", NJ" and em-dashes are intentional,
// copied verbatim from scripts/prerender-test-home.mjs). ----

// PLACES: three framing branches (home > delivers > near), matching the
// prerender's placeSeo block. `delivers` is computed identically:
// town.distanceMiles <= (Number(delivery_max_radius_miles) || 0).
function autoPlaceSeo(restaurant, cuisine, town, ownCitySlug) {
  const isHome = town.slug === ownCitySlug
  const boundary = Number(restaurant.delivery_max_radius_miles) || 0
  const delivers = town.distanceMiles != null && town.distanceMiles <= boundary
  const title = isHome
    ? `Best ${cuisine} in ${town.name}, NJ | ${restaurant.name}`
    : delivers
    ? `Best ${cuisine} around ${town.name}, NJ | ${restaurant.name}`
    : `Best ${cuisine} near ${town.name}, NJ | ${restaurant.name}`
  const description = isHome
    ? `${restaurant.name} is your local ${cuisine} spot in ${town.name}, NJ. View the menu, hours, and order directly online for pickup or delivery.`
    : delivers
    ? `Order ${cuisine} for pickup or delivery to ${town.name}. ${restaurant.name} delivers to ${town.name} — support local.`
    : `Looking for ${cuisine} near ${town.name}? ${restaurant.name} serves the area — order online for pickup or delivery.`
  return { title, description }
}

// TAGS: no branching — matches the prerender's tagSeo block.
function autoTagSeo(restaurant, def) {
  return {
    title: `${def.label} | ${restaurant.name}`,
    description: `Order ${def.label.toLowerCase()} from ${restaurant.name} — made fresh daily. Pickup or delivery.`,
  }
}

// A single override-editing section (rendered twice: places + tags). Keyed on
// restaurant+pageType by the parent so it remounts fresh per restaurant, letting
// the useState initializer read props directly (no sync effect needed).
//
// rows:     [{ slug, label, autoTitle, autoDescription }]
// existing: Map(slug -> seo_pages row) — prefill for pages that already have overrides
//
// SPARSE save: a page is only written when it's a real exception (title OR
// description override, OR enabled=false). A row cleared back to all-defaults is
// DELETED, so an empty table means "everything auto-generates".
function SeoPageRows({ pageType, restaurantId, heading, rowLabel, rows, existing, onSaved }) {
  const [edits, setEdits] = useState(() => {
    const m = {}
    for (const row of rows) {
      const ex = existing.get(row.slug)
      m[row.slug] = {
        title: ex?.title_override || '',
        description: ex?.meta_description_override || '',
        enabled: ex ? ex.enabled : true,
      }
    }
    return m
  })
  const [saving, setSaving] = useState(false)

  function setField(slug, field, value) {
    setEdits((prev) => ({ ...prev, [slug]: { ...prev[slug], [field]: value } }))
  }

  async function handleSave() {
    setSaving(true)
    const toUpsert = []
    const toDelete = []
    for (const row of rows) {
      const e = edits[row.slug]
      const title = e.title.trim() || null
      const description = e.description.trim() || null
      const enabled = e.enabled
      const isException = title !== null || description !== null || enabled === false
      if (isException) {
        toUpsert.push({
          restaurant_id: restaurantId,
          page_type: pageType,
          slug: row.slug,
          title_override: title,
          meta_description_override: description,
          enabled,
        })
      } else if (existing.has(row.slug)) {
        // Reset to all-defaults but a row exists → delete it (keep table sparse).
        toDelete.push(row.slug)
      }
    }

    let err = null
    if (toUpsert.length) {
      const { error } = await supabase
        .from('seo_pages')
        .upsert(toUpsert, { onConflict: 'restaurant_id,page_type,slug' })
      if (error) err = error
    }
    if (!err && toDelete.length) {
      const { error } = await supabase
        .from('seo_pages')
        .delete()
        .eq('restaurant_id', restaurantId)
        .eq('page_type', pageType)
        .in('slug', toDelete)
      if (error) err = error
    }

    setSaving(false)
    if (err) {
      toast.error(`${heading} save failed: ${err.message}`)
      return
    }
    toast.success(`${heading} saved`)
    onSaved?.()
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">{heading}</h3>
      <p className="text-xs text-gray-400 mb-4">
        Leave a field blank to use the auto-generated value. Filling one overrides it.
        Uncheck a page to hide it from search.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">No {rowLabel} pages generate for this restaurant.</p>
      ) : (
        <div className="space-y-5">
          {rows.map((row) => {
            const e = edits[row.slug]
            return (
              <div key={row.slug} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-sm font-semibold text-gray-800">{row.label}</span>
                  <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                    <input
                      type="checkbox"
                      checked={e.enabled}
                      onChange={(ev) => setField(row.slug, 'enabled', ev.target.checked)}
                      className="h-4 w-4 accent-[#16A34A]"
                    />
                    Enabled
                  </label>
                </div>
                <div className="space-y-2">
                  <input
                    value={e.title}
                    onChange={(ev) => setField(row.slug, 'title', ev.target.value)}
                    placeholder={row.autoTitle}
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                  <textarea
                    value={e.description}
                    onChange={(ev) => setField(row.slug, 'description', ev.target.value)}
                    rows={2}
                    placeholder={row.autoDescription}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rows.length > 0 && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="mt-4 w-full md:w-auto px-6 h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D] transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      )}
    </div>
  )
}

export default function SeoTab() {
  const [restaurants, setRestaurants] = useState([])
  const [selectedRestaurant, setSelectedRestaurant] = useState('')
  const [cuisine, setCuisine] = useState('')
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [gscVerification, setGscVerification] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-restaurant data for the /places + /tags sections (null = not yet loaded).
  const [menuData, setMenuData] = useState(null) // { categories, items }
  const [seoRows, setSeoRows] = useState(null) // seo_pages rows for the restaurant

  // Load every restaurant with all SEO fields + geo/delivery fields up front.
  useEffect(() => {
    supabase
      .from('restaurants')
      .select('id, name, slug, address, cuisine, seo_title, seo_description, gsc_verification, latitude, longitude, delivery_max_radius_miles')
      .order('name')
      .then(({ data }) => setRestaurants(data || []))
  }, [])

  // Reset the homepage edit fields to the selected row's values (null → empty).
  useEffect(() => {
    const r = restaurants.find(x => x.id === selectedRestaurant)
    setCuisine(r?.cuisine || '')
    setSeoTitle(r?.seo_title || '')
    setSeoDescription(r?.seo_description || '')
    setGscVerification(r?.gsc_verification || '')
  }, [selectedRestaurant, restaurants])

  // Fetch the /places + /tags source data on restaurant select.
  useEffect(() => {
    if (!selectedRestaurant) {
      setMenuData(null)
      setSeoRows(null)
      return
    }
    let cancelled = false
    setMenuData(null)
    setSeoRows(null)
    ;(async () => {
      const [cats, items, seo] = await Promise.all([
        supabase.from('menu_categories').select('id, name').eq('restaurant_id', selectedRestaurant),
        supabase.from('menu_items').select('id, category_id').eq('restaurant_id', selectedRestaurant),
        supabase.from('seo_pages').select('*').eq('restaurant_id', selectedRestaurant),
      ])
      if (cancelled) return
      setMenuData({ categories: cats.data || [], items: items.data || [] })
      setSeoRows(seo.data || [])
    })()
    return () => { cancelled = true }
  }, [selectedRestaurant])

  const selected = restaurants.find(r => r.id === selectedRestaurant)
  const name = selected?.name || 'Restaurant'
  const effCuisine = cuisine.trim() || 'Pizza'
  // Resolve town/state from the selected restaurant's address so the placeholder
  // shows the REAL auto-formula (e.g. "Best Pizza in Old Tappan, NJ"). Falls back
  // to literal {town}/{state} tokens when the address can't be parsed — mirrors
  // seoHead.js's own `city && state` guard.
  const { city, state } = parseAddress(selected?.address)
  const town = city || '{town}'
  const st = state || '{state}'
  const titlePlaceholder = `${name} | Best ${effCuisine} in ${town}, ${st}`
  const descPlaceholder = `${name}: the best ${effCuisine} in ${town}, ${st}. View our menu, hours, and location. Order directly online for pickup or delivery.`

  // ---- /places rows — derived from the SAME shared geo logic the prerender uses,
  // including the home-town-keep + 0.5mi mis-geocode guard filter. ----
  const townData = useMemo(() => {
    if (!selected) return { towns: [], ownCitySlug: '' }
    const { city: ownCity } = parseAddress(selected.address)
    const ownCitySlug = (ownCity || '').toLowerCase().replace(/\s+/g, '-')
    const county = NJ_TOWNS.find(t => t.slug === ownCitySlug)?.county
    const places = findNearestTowns(
      { lat: selected.latitude, lng: selected.longitude, county },
      NJ_TOWNS,
      { radiusMiles: MAX_RADIUS_MILES, limit: 20 }
    )
    const towns = places.filter(t => (t.slug === ownCitySlug ? true : t.distanceMiles >= 0.5))
    return { towns, ownCitySlug }
  }, [selected])

  const placeRows = useMemo(() => {
    if (!selected) return []
    const c = selected.cuisine || 'Pizza'
    return townData.towns.map((t) => {
      const a = autoPlaceSeo(selected, c, t, townData.ownCitySlug)
      return { slug: t.slug, label: t.name, autoTitle: a.title, autoDescription: a.description }
    })
  }, [selected, townData])

  // ---- /tags rows — the SAME shared resolver the prerender uses. ----
  const tagRows = useMemo(() => {
    if (!selected || !menuData) return []
    const generated = resolveGeneratedTags({
      allowlist: TAG_KEYWORDS.tags,
      categories: menuData.categories,
      items: menuData.items,
    })
    return generated.map(({ def }) => {
      const a = autoTagSeo(selected, def)
      return { slug: def.slug, label: def.label, autoTitle: a.title, autoDescription: a.description }
    })
  }, [selected, menuData])

  const placeExisting = useMemo(
    () => new Map((seoRows || []).filter(r => r.page_type === 'place').map(r => [r.slug, r])),
    [seoRows]
  )
  const tagExisting = useMemo(
    () => new Map((seoRows || []).filter(r => r.page_type === 'tag').map(r => [r.slug, r])),
    [seoRows]
  )

  const sectionsReady = selected && menuData !== null && seoRows !== null

  function refreshSeoRows() {
    if (!selectedRestaurant) return
    supabase
      .from('seo_pages')
      .select('*')
      .eq('restaurant_id', selectedRestaurant)
      .then(({ data }) => setSeoRows(data || []))
  }

  async function handleSave() {
    if (!selectedRestaurant) return
    setSaving(true)
    // Empty string → null so clearing an override restores the auto-formula.
    const payload = {
      cuisine: cuisine.trim() || null,
      seo_title: seoTitle.trim() || null,
      seo_description: seoDescription.trim() || null,
      gsc_verification: gscVerification.trim() || null,
    }
    const { data, error } = await supabase
      .from('restaurants')
      .update(payload)
      .eq('id', selectedRestaurant)
      .select()
      .single()
    setSaving(false)
    if (error) {
      toast.error(`SEO save failed: ${error.message}`)
      return
    }
    toast.success('SEO saved')
    // Reflect saved values back into the list so the picker/edit state stay in sync.
    setRestaurants(prev => prev.map(r => (r.id === data.id ? { ...r, ...data } : r)))
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4">
          <h2 className="text-xl font-bold w-full md:w-auto">SEO</h2>
          <select
            value={selectedRestaurant}
            onChange={e => setSelectedRestaurant(e.target.value)}
            className="h-11 md:h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white flex-1 md:flex-none min-w-0"
          >
            <option value="">Select a restaurant...</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {!selectedRestaurant ? (
          <p className="text-gray-400 text-center mt-8">Select a restaurant to edit its SEO</p>
        ) : (
          <div className="max-w-xl space-y-8">
            {/* ---- 1. Homepage SEO (restaurants table) — UNCHANGED ---- */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Homepage SEO</h3>
              <p className="text-xs text-gray-400 mb-4">
                Leave a field blank to use the auto-generated value. Filling one overrides it.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-gray-500">Cuisine</label>
                  <input
                    value={cuisine}
                    onChange={e => setCuisine(e.target.value)}
                    placeholder="Pizza"
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">SEO Title</label>
                  <input
                    value={seoTitle}
                    onChange={e => setSeoTitle(e.target.value)}
                    placeholder={titlePlaceholder}
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">SEO Description</label>
                  <textarea
                    value={seoDescription}
                    onChange={e => setSeoDescription(e.target.value)}
                    rows={3}
                    placeholder={descPlaceholder}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Google Search Console verification</label>
                  <input
                    value={gscVerification}
                    onChange={(e) => setGscVerification(e.target.value)}
                    placeholder="Paste the content value from GSC's HTML tag method"
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    From GSC → Add property → HTML tag: paste only the content="..." value (the token), not the full tag. Injected into this restaurant's home page &lt;head&gt; on next deploy.
                  </p>
                </div>
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className="mt-4 w-full md:w-auto px-6 h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D] transition-colors"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>

            {/* ---- 2 & 3. Per-page overrides (seo_pages table) ---- */}
            {!sectionsReady ? (
              <p className="text-sm text-gray-400">Loading page lists…</p>
            ) : (
              <>
                <SeoPageRows
                  key={`place-${selectedRestaurant}`}
                  pageType="place"
                  restaurantId={selectedRestaurant}
                  heading="Location Pages (/places)"
                  rowLabel="location"
                  rows={placeRows}
                  existing={placeExisting}
                  onSaved={refreshSeoRows}
                />
                <SeoPageRows
                  key={`tag-${selectedRestaurant}`}
                  pageType="tag"
                  restaurantId={selectedRestaurant}
                  heading="Menu Pages (/tags)"
                  rowLabel="menu"
                  rows={tagRows}
                  existing={tagExisting}
                  onSaved={refreshSeoRows}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
