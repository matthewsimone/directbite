import { useEffect, useRef, useState } from 'react'

const SWIPE_THRESHOLD = 50

function Lightbox({ urls, index, onClose, onPrev, onNext }) {
  const touchStartX = useRef(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  function onTouchStart(e) {
    touchStartX.current = e.touches[0].clientX
  }

  function onTouchEnd(e) {
    if (touchStartX.current == null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    if (Math.abs(dx) > SWIPE_THRESHOLD) {
      if (dx > 0) onPrev()
      else onNext()
    }
    touchStartX.current = null
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        aria-label="Close"
        className="absolute top-4 right-4 text-white text-3xl leading-none w-10 h-10 flex items-center justify-center"
      >
        &times;
      </button>

      {urls.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onPrev() }}
            aria-label="Previous"
            className="absolute left-4 md:left-8 text-white w-12 h-12 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-full"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onNext() }}
            aria-label="Next"
            className="absolute right-4 md:right-8 text-white w-12 h-12 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-full"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      <img
        src={urls[index]}
        alt={`Gallery photo ${index + 1}`}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[90vh] object-contain rounded-lg"
      />
    </div>
  )
}

export default function Gallery({ urls }) {
  const [openIdx, setOpenIdx] = useState(null)

  function prev() {
    setOpenIdx(i => (i === 0 ? urls.length - 1 : i - 1))
  }
  function next() {
    setOpenIdx(i => (i === urls.length - 1 ? 0 : i + 1))
  }

  return (
    <section className="bg-white py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8">
          A Gallery of Flavors
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {urls.map((url, i) => (
            <button
              key={url + i}
              onClick={() => setOpenIdx(i)}
              className="aspect-square overflow-hidden rounded-2xl bg-gray-100"
            >
              <img
                src={url}
                alt={`Gallery photo ${i + 1}`}
                className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>

      {openIdx != null && (
        <Lightbox
          urls={urls}
          index={openIdx}
          onClose={() => setOpenIdx(null)}
          onPrev={prev}
          onNext={next}
        />
      )}
    </section>
  )
}
