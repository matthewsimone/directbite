import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useMenu(restaurantId) {
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [sizes, setSizes] = useState([])
  const [toppingGroups, setToppingGroups] = useState([])
  const [toppings, setToppings] = useState([])
  const [itemToppingGroups, setItemToppingGroups] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!restaurantId || !supabase) return

    async function fetch() {
      setLoading(true)

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

      setCategories(catRes.data || [])
      setItems(itemRes.data || [])
      setSizes(sizeRes.data || [])
      setToppingGroups(tgRes.data || [])
      setToppings(topRes.data || [])
      setItemToppingGroups(itgRes.data || [])

      setLoading(false)
    }

    fetch()
  }, [restaurantId])

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
