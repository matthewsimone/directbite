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

      const [catRes, itemRes, sizeRes, tgRes, topRes, itgRes] = await Promise.all([
        supabase.from('menu_categories').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('menu_items').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('item_sizes').select('*').order('sort_order'),
        supabase.from('topping_groups').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('toppings').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
        supabase.from('item_topping_groups').select('*'),
      ])

      setCategories(catRes.data || [])
      setItems(itemRes.data || [])

      // Filter sizes to only those belonging to this restaurant's items
      const itemIds = new Set((itemRes.data || []).map(i => i.id))
      setSizes((sizeRes.data || []).filter(s => itemIds.has(s.item_id)))

      setToppingGroups(tgRes.data || [])
      setToppings(topRes.data || [])

      // Filter item_topping_groups to this restaurant's items
      setItemToppingGroups((itgRes.data || []).filter(itg => itemIds.has(itg.item_id)))

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
    const groupIds = itemToppingGroups
      .filter(itg => itg.item_id === itemId)
      .map(itg => itg.topping_group_id)
    return toppingGroups.filter(tg => groupIds.includes(tg.id))
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
