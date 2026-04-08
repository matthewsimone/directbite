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
      <div className="flex gap-1 px-4 py-2 min-w-max">
        {categories.map(cat => (
          <button
            key={cat.id}
            ref={el => (tabRefs.current[cat.id] = el)}
            onClick={() => onSelect(cat.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeId === cat.id
                ? 'bg-[#16A34A] text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>
    </div>
  )
}
