import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'

const FEATURED_LIMIT = 8

// Available items first, unavailable after, WITHIN each category. The category
// grouping and the order in which categories first appear are both preserved,
// and each group keeps the relative order the query returned (sort_order, then
// name). Two filter passes per category rather than one .sort() with a boolean
// comparator: filter is specified to preserve order, so neither group can be
// disturbed internally.
//
// Called EXACTLY ONCE, in fetchMenu, on the raw query result — the ordering is
// baked into the array that reaches state. Deriving it during render instead
// would re-sort on every state change, so toggling an item would make its row
// jump out from under the operator's finger the instant they tapped it.
function orderByAvailability(rows) {
  const byCategory = new Map()
  for (const row of rows) {
    if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, [])
    byCategory.get(row.category_id).push(row)
  }
  const out = []
  // Map iterates in insertion order, so categories come back in the order they
  // first appeared in the query result.
  for (const group of byCategory.values()) {
    out.push(...group.filter(i => i.is_available))
    out.push(...group.filter(i => !i.is_available))
  }
  return out
}

export default function MenuTab({ restaurant }) {
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  // id of the item whose availability write is in flight, or null. Its toggle
  // is disabled until the write settles, which closes the double-tap path:
  // without it a second tap fires a second write computed from the same stale
  // item.is_available, so the two writes disagree and the last to land wins.
  const [togglingId, setTogglingId] = useState(null)

  useEffect(() => {
    fetchMenu()
  }, [restaurant?.id])

  async function fetchMenu() {
    if (!restaurant) return

    const [catRes, itemRes] = await Promise.all([
      supabase
        .from('menu_categories')
        .select('*')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order'),
      supabase
        .from('menu_items')
        .select('*, item_sizes(*)')
        .eq('restaurant_id', restaurant.id)
        // sort_order defaults to 0 (001_initial_schema.sql:53), so a restaurant
        // that never reordered has every item at 0 and Postgres is free to
        // return them in any order — including a different one each fetch.
        // name is the tiebreaker that makes the list stable.
        .order('sort_order')
        .order('name'),
    ])

    setCategories(catRes.data || [])
    setItems(orderByAvailability(itemRes.data || []))
    setLoading(false)
  }

  async function toggleAvailability(item) {
    // The button is already disabled while this item is in flight; this is the
    // belt-and-braces guard for any path that reaches the handler anyway.
    if (togglingId === item.id) return
    const newVal = !item.is_available
    setTogglingId(item.id)
    try {
      const { error } = await supabase
        .from('menu_items')
        .update({ is_available: newVal })
        .eq('id', item.id)

      if (error) {
        toast.error(`Update failed: ${error.message}`)
        return
      }
      // Updates the row in place — Array.prototype.map preserves position, so
      // the row greys where it sits and does not move. It takes its sorted
      // position on the next fetchMenu.
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_available: newVal } : i))
      toast.success(newVal ? 'Item available' : 'Item unavailable')
    } finally {
      setTogglingId(null)
    }
  }

  async function toggleFeatured(item) {
    const turningOn = !item.featured_on_website
    if (turningOn && featuredCount >= FEATURED_LIMIT) {
      toast.error('Feature limit reached. Unfeature another item first.')
      return
    }
    const nextOrder = turningOn ? featuredCount : null
    const { error } = await supabase
      .from('menu_items')
      .update({ featured_on_website: turningOn, featured_order: nextOrder })
      .eq('id', item.id)

    if (error) {
      toast.error(`Update failed: ${error.message}`)
      return
    }
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, featured_on_website: turningOn, featured_order: nextOrder } : i))
    toast.success(turningOn ? 'Featured on website' : 'Removed from featured')
  }

  function getMinPrice(item) {
    const sizes = item.item_sizes || []
    if (sizes.length === 0) return null
    const min = Math.min(...sizes.map(s => Number(s.price)))
    return `$${min.toFixed(2)}`
  }

  const featuredCount = items.filter(i => i.featured_on_website).length

  if (loading) {
    return <p className="text-center text-gray-400 mt-8">Loading menu...</p>
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">Featured on website: <span className="font-semibold text-gray-700">{featuredCount} / {FEATURED_LIMIT}</span></p>
      </div>
      {categories.length === 0 ? (
        <p className="text-center text-gray-400 mt-8">No menu categories</p>
      ) : (
        categories.map(cat => {
          const catItems = items.filter(i => i.category_id === cat.id)
          return (
            <div key={cat.id}>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                {cat.name}
              </h3>
              <div className="space-y-2">
                {catItems.map(item => (
                  <div
                    key={item.id}
                    className={`p-4 bg-white rounded-xl border border-gray-200 transition-opacity ${
                      !item.is_available ? 'opacity-40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0 mr-4">
                        <p className="font-medium text-base truncate">{item.name}</p>
                        {getMinPrice(item) && (
                          <p className="text-sm text-gray-500">{getMinPrice(item)}{item.item_sizes?.length > 1 ? '+' : ''}</p>
                        )}
                      </div>
                      <button
                        onClick={() => toggleAvailability(item)}
                        disabled={togglingId === item.id}
                        className={`relative w-14 h-8 rounded-full transition-colors shrink-0 disabled:opacity-60 ${
                          item.is_available ? 'bg-[#16A34A]' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                            item.is_available ? 'left-7' : 'left-1'
                          }`}
                        />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                      <span className="text-xs text-gray-500">Feature on Website</span>
                      <button
                        onClick={() => toggleFeatured(item)}
                        className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                          item.featured_on_website ? 'bg-[#16A34A]' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                            item.featured_on_website ? 'left-5.5' : 'left-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                ))}
                {catItems.length === 0 && (
                  <p className="text-sm text-gray-400 pl-2">No items in this category</p>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
