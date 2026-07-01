// Prerender-safe static menu page for /{slug}/menu.
//
// Prop-fed content (no useCart, useWalletDetection, useMenu, scroll-spy,
// ItemModal, and no window/document/localStorage AT RENDER TIME). Every item is
// emitted into the initial HTML, grouped by category, so the full menu is
// crawlable without JS.
//
// Renders the website TopBar above the menu — same as HomePage/LinkViewer. The
// only hook here is the open/closed `status`, using the identical hydration-safe
// placeholder + effect-tick pattern those pages use (server and first client
// render emit the static CLOSED state, so hydration matches; the live value
// settles on the post-hydrate tick). TopBar's drawer/HoursModal are guarded
// behind their closed state, so nothing touches the DOM during renderToString —
// this is exactly what the HomePage prerender already exercises.
//
// Reuses the EXISTING MenuItemCard unchanged. Card clicks send the browser to
// the ordering page's item deep-link (?item={id}); the ordering MenuPage already
// restores the ItemModal from that param. onClick (not an <a> wrapper) keeps
// MenuItemCard's <button> valid — a <button> nested in <a> is invalid HTML that
// browsers un-nest, which would cause a hydration mismatch. The arrow isn't
// invoked during renderToString, so referencing window here is build-safe.

import { useState, useEffect } from 'react'
import MenuItemCard from '../../components/MenuItemCard'
import TopBar from './components/TopBar'
import { getStatus } from './utils/hours'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function MenuStatic({ restaurant, hours, categories, items, lowestPrices }) {
  const slug = restaurant.slug
  const itemsFor = (categoryId) => items.filter((i) => i.category_id === categoryId)

  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  useEffect(() => {
    function tick() { setStatus(getStatus(hours || [], new Date())) }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR

  return (
    <div className="min-h-dvh bg-gray-50" style={{ '--brand-color': brandColor }}>
      <TopBar restaurant={restaurant} status={status} hours={hours} solid />

      <div className="max-w-[1100px] mx-auto px-6 sm:px-8 py-8">
        <header className="mb-2">
          <h1 className="text-2xl font-bold text-gray-900">{restaurant.name} Menu</h1>
          <a
            href={`/${slug}`}
            className="mt-1 inline-block text-[14px] font-semibold text-[#16A34A] hover:underline"
          >
            Order online →
          </a>
        </header>

        {categories.map((cat) => {
          const catItems = itemsFor(cat.id)
          if (catItems.length === 0) return null

          return (
            <section key={cat.id} className="mb-8">
              <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">{cat.name}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {catItems.map((item) => (
                  <MenuItemCard
                    key={item.id}
                    item={item}
                    lowestPrice={lowestPrices[item.id]}
                    onClick={() => {
                      window.location.href = `/${slug}?item=${item.id}`
                    }}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
