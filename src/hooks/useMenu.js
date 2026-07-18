import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { boundedFetch } from '../lib/boundedFetch'

export function useMenu(restaurantId) {
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [sizes, setSizes] = useState([])
  const [toppingGroups, setToppingGroups] = useState([])
  const [toppings, setToppings] = useState([])
  const [itemToppingGroups, setItemToppingGroups] = useState([])
  const [loading, setLoading] = useState(true)
  // Bounded-fetch UI signals: `stalled` = the 2500ms hedge started; `failed` =
  // the 10s hard deadline fired (show retry in the menu region).
  const [stalled, setStalled] = useState(false)
  const [failed, setFailed] = useState(false)

  // See useRestaurant for rationale — guard async setState against
  // post-unmount + StrictMode double-invocation.
  const mountedRef = useRef(true)
  // Outer controller for the current load(); a new load()/retry() or unmount
  // aborts the prior one so its bounded-fetch attempts stop and never strand.
  const loadAbortRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadAbortRef.current?.abort()
    }
  }, [])

  const load = useCallback(async () => {
    // A misconfigured client can never resolve — clear loading so the page
    // isn't stranded on the skeleton. (No behavior change in prod, where the
    // client is always configured.)
    if (!supabase) { if (mountedRef.current) setLoading(false); return }
    // No restaurant id yet → the menu genuinely isn't ready; keep loading true
    // (MenuPage's restLoading drives the skeleton) and wait for the effect to
    // re-run load() once restaurantId is set.
    if (!restaurantId) return

    // Supersede any in-flight load; this one owns loading/stalled/failed.
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const outerSignal = controller.signal
    const isCurrent = () => mountedRef.current && loadAbortRef.current === controller
    // One shared 10s ceiling for this load (single group today; kept explicit so
    // a future two-phase split shares the same budget rather than 10s per phase).
    const deadlineAt = Date.now() + 10000

    if (mountedRef.current) { setLoading(true); setStalled(false); setFailed(false) }

    try {
      // item_sizes and item_topping_groups have no restaurant_id column,
      // so we filter via an inner-join on menu_items. Without this, the
      // queries pull globally and hit PostgREST's 1000-row default cap —
      // for restaurants whose links sit past row 1000 in the global table,
      // some rows silently vanish and items render with missing modifiers.
      const grp = await boundedFetch(
        [
          (s) => supabase.from('menu_categories').select('*').eq('restaurant_id', restaurantId).order('sort_order').abortSignal(s).retry(false),
          (s) => supabase.from('menu_items').select('*, menu_categories(discount_exempt)').eq('restaurant_id', restaurantId).order('sort_order').abortSignal(s).retry(false),
          (s) => supabase.from('item_sizes').select('*, menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', restaurantId).order('sort_order').abortSignal(s).retry(false),
          (s) => supabase.from('topping_groups').select('*').eq('restaurant_id', restaurantId).order('sort_order').abortSignal(s).retry(false),
          (s) => supabase.from('toppings').select('*').eq('restaurant_id', restaurantId).order('sort_order').abortSignal(s).retry(false),
          (s) => supabase.from('item_topping_groups').select('*, menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', restaurantId).abortSignal(s).retry(false),
        ],
        { deadlineAt, onStalled: () => { if (isCurrent()) setStalled(true) }, signal: outerSignal }
      )
      if (grp.cancelled || !isCurrent()) return
      if (grp.timedOut) { setFailed(true); return }
      setStalled(false)

      const [catRes, itemRes, sizeRes, tgRes, topRes, itgRes] = grp.results
      setCategories(catRes.data || [])
      // Flatten the joined category flag onto each item so consumers read
      // item.discount_exempt directly (default false when missing = not exempt).
      const itemsWithExempt = (itemRes.data || []).map(it => ({
        ...it,
        discount_exempt: it.menu_categories?.discount_exempt ?? false,
      }))
      setItems(itemsWithExempt)
      setSizes(sizeRes.data || [])
      setToppingGroups(tgRes.data || [])
      setToppings(topRes.data || [])
      setItemToppingGroups(itgRes.data || [])
    } catch (err) {
      if (isCurrent()) {
        console.error('useMenu: load failed', err)
      }
    } finally {
      // Only the current (non-superseded) load clears loading.
      if (isCurrent()) setLoading(false)
    }
  }, [restaurantId])

  useEffect(() => {
    load()
  }, [load])

  // Phone backgrounded → returned: re-run the fetch in case the in-flight
  // request was suspended and never resolved.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [load])

  // Manual retry (Retry button / refocus-while-failed). load() aborts any
  // stale attempt and resets stalled/failed before re-fetching.
  const retry = useCallback(() => { load() }, [load])

  function getItemsByCategory(categoryId) {
    return items.filter(i => i.category_id === categoryId)
  }

  function getSizesForItem(itemId) {
    return sizes.filter(s => s.item_id === itemId)
  }

  function getToppingGroupsForItem(itemId) {
    const links = itemToppingGroups
      .filter(itg => itg.item_id === itemId)
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    const byId = new Map(toppingGroups.map(g => [g.id, g]))
    return links.map(l => byId.get(l.topping_group_id)).filter(Boolean)
  }

  function getToppingsForGroup(groupId) {
    return toppings.filter(t => t.topping_group_id === groupId)
  }

  function getLowestPrice(itemId) {
    const itemSizes = getSizesForItem(itemId)
    if (itemSizes.length === 0) return null
    return Math.min(...itemSizes.map(s => Number(s.price)))
  }

  return {
    categories,
    items,
    sizes,
    toppingGroups,
    toppings,
    loading,
    stalled,
    failed,
    retry,
    getItemsByCategory,
    getSizesForItem,
    getToppingGroupsForItem,
    getToppingsForGroup,
    getLowestPrice,
  }
}
