// Prerender-safe static menu page for /{slug}/menu.
//
// Pure + prop-fed: NO hooks that touch the browser (no useCart,
// useWalletDetection, useMenu, scroll-spy, ItemModal, window/document/
// localStorage at render time). Every item is emitted into the initial HTML,
// grouped by category, so the full menu is crawlable without JS.
//
// Reuses the EXISTING MenuItemCard unchanged. Card clicks send the browser to
// the ordering page's item deep-link (?item={id}) — the ordering MenuPage
// already restores the ItemModal from that param. We use an onClick that sets
// window.location (NOT an <a> wrapper): MenuItemCard renders a <button>, and a
// <button> nested in an <a> is invalid HTML that browsers un-nest, which would
// cause a hydration mismatch. The arrow isn't invoked during renderToString,
// so referencing window here is build-safe.

import MenuItemCard from '../../components/MenuItemCard'

export default function MenuStatic({ restaurant, categories, items, lowestPrices }) {
  const slug = restaurant.slug
  const itemsFor = (categoryId) => items.filter((i) => i.category_id === categoryId)

  return (
    <div className="min-h-screen bg-gray-50">
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
