import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

export default function MenuTab({ restaurant }) {
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

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
        .order('sort_order'),
    ])

    setCategories(catRes.data || [])
    setItems(itemRes.data || [])
    setLoading(false)
  }

  async function toggleAvailability(item) {
    const newVal = !item.is_available
    const { error } = await supabase
      .from('menu_items')
      .update({ is_available: newVal })
      .eq('id', item.id)

    if (!error) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_available: newVal } : i))
    }
  }

  function getMinPrice(item) {
    const sizes = item.item_sizes || []
    if (sizes.length === 0) return null
    const min = Math.min(...sizes.map(s => Number(s.price)))
    return `$${min.toFixed(2)}`
  }

  if (loading) {
    return <p className="text-center text-gray-400 mt-8">Loading menu...</p>
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-6">
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
                    className={`flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200 transition-opacity ${
                      !item.is_available ? 'opacity-40' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0 mr-4">
                      <p className="font-medium text-base truncate">{item.name}</p>
                      {getMinPrice(item) && (
                        <p className="text-sm text-gray-500">{getMinPrice(item)}{item.item_sizes?.length > 1 ? '+' : ''}</p>
                      )}
                    </div>
                    <button
                      onClick={() => toggleAvailability(item)}
                      className={`relative w-14 h-8 rounded-full transition-colors ${
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
