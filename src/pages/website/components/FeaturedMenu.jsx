import { useEffect, useState } from 'react'
import OrderLink from './OrderLink'
import { supabase } from '../../../lib/supabase'

function formatPrice(item) {
  const sizes = item.item_sizes || []
  if (sizes.length === 0) return null
  const min = Math.min(...sizes.map(s => Number(s.price)))
  const label = `$${min.toFixed(2)}`
  return sizes.length > 1 ? `Starts at ${label}` : label
}

function ItemCard({ item, slug }) {
  return (
    <OrderLink
      slug={slug}
      suffix={`?item=${item.id}`}
      className="block w-[220px] shrink-0 snap-start group"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-gray-100">
        <img
          src={item.image_url}
          alt={item.name}
          className="img-crisp w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-white shadow flex items-center justify-center text-xl font-bold leading-none"
          style={{ color: 'var(--brand-color)' }}
        >
          +
        </span>
      </div>
      <div className="px-1 mt-3">
        <p className="font-semibold text-gray-900 truncate">{item.name}</p>
        {formatPrice(item) && (
          <p className="text-sm text-gray-600 mt-0.5">{formatPrice(item)}</p>
        )}
      </div>
    </OrderLink>
  )
}

// Pure, prop-fed presentation — the featured carousel/grid. Reusable anywhere:
// the homepage via FeaturedMenu's fetch, /places via the prerender's props.
// No hooks, no fetch, no window — safe to server-render.
export function FeaturedGrid({ items, slug }) {
  if (!items || items.length === 0) return null

  return (
    <section className="bg-white py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8">Featured</h2>

        {/* Mobile: horizontal scroll */}
        <div className="md:hidden flex gap-4 overflow-x-auto snap-x snap-mandatory scroll-pl-6 pb-2 -mx-6 px-6">
          {items.map(item => (
            <ItemCard key={item.id} item={item} slug={slug} />
          ))}
        </div>

        {/* Desktop: flex-wrap so cards stay 220px without stretching */}
        <div className="hidden md:flex md:flex-wrap gap-6">
          {items.map(item => (
            <ItemCard key={item.id} item={item} slug={slug} />
          ))}
        </div>
      </div>
    </section>
  )
}

export default function FeaturedMenu({ restaurant }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!restaurant?.id) return
    async function fetch() {
      const { data } = await supabase
        .from('menu_items')
        .select('*, item_sizes(*)')
        .eq('restaurant_id', restaurant.id)
        .eq('featured_on_website', true)
        .order('featured_order', { ascending: true })
        .limit(8)
      setItems((data || []).filter(i => i.image_url))
      setLoading(false)
    }
    fetch()
  }, [restaurant?.id])

  if (loading) return null
  if (items.length === 0) return null

  return <FeaturedGrid items={items} slug={restaurant.slug} />
}
