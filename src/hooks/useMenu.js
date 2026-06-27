import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

export function useMenu(restaurantId) {
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [sizes, setSizes] = useState([])
  const [toppingGroups, setToppingGroups] = useState([])
  const [toppings, setToppings] = useState([])
  const [itemToppingGroups, setItemToppingGroups] = useState([])
  const [loading, setLoading] = useState(true)

  // See useRestaurant for rationale — guard async setState against
  // post-unmount + StrictMode double-invocation.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!restaurantId || !supabase) return
    if (mountedRef.current) setLoading(true)

    try {
      // item_sizes and item_topping_groups have no restaurant_id column,
      // so we filter via an inner-join on menu_items. Without this, the
      // queries pull globally and hit PostgREST's 1000-row default cap —
      // for restaurants whose links sit past row 1000 in the global table,
      // some rows silently vanish and items render with missing modifiers.
      const [catRes, itemRes, sizeRes, tgRes, topRes, itgRes] = await Promise.all([
        supabase.from('menu_categories').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('menu_items').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('item_sizes').select('*, menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', restaurantId).order('sort_order'),
        supabase.from('topping_groups').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('toppings').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('item_topping_groups').select('*, menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', restaurantId),
      ])

      if (!mountedRef.current) return

      setCategories(catRes.data || [])
      setItems(itemRes.data || [])
      setSizes(sizeRes.data || [])
      setToppingGroups(tgRes.data || [])
      setToppings(topRes.data || [])
      setItemToppingGroups(itgRes.data || [])
    } catch (err) {
      if (mountedRef.current) {
        console.error('useMenu: load failed', err)
      }
    } finally {
      if (mountedRef.current) setLoading(false)
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
    getItemsByCategory,
    getSizesForItem,
    getToppingGroupsForItem,
    getToppingsForGroup,
    getLowestPrice,
  }
}
