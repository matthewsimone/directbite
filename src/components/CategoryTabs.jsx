import { useRef, useEffect, useState } from 'react'

export default function CategoryTabs({ categories, activeId, onSelect }) {
  const scrollRef = useRef(null)
  const tabRefs = useRef({})
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (mounted && activeId && tabRefs.current[activeId]) {
      tabRefs.current[activeId].scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      })
    }
  }, [activeId, mounted])

  return (
    <div
      ref={scrollRef}
      className="sticky top-0 z-30 bg-white border-b border-gray-200 overflow-x-auto scrollbar-hide"
    >
      <div className="flex gap-6 px-6 sm:px-8 min-w-max max-w-[1100px] mx-auto">
        {categories.map(cat => (
          <button
            key={cat.id}
            ref={el => (tabRefs.current[cat.id] = el)}
            onClick={() => onSelect(cat.id)}
            className={`relative py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              activeId === cat.id
                ? 'text-[#16A34A]'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {cat.name}
            {activeId === cat.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
