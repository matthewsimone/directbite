import { useState } from 'react'

const SEE_MORE_THRESHOLD = 120

function Stars({ count }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <svg
          key={n}
          className="w-5 h-5"
          viewBox="0 0 20 20"
          fill={n <= count ? 'var(--brand-color)' : 'currentColor'}
          style={n <= count ? undefined : { color: '#e5e7eb' }}
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.957a1 1 0 00.95.69h4.162c.969 0 1.371 1.24.588 1.81l-3.367 2.446a1 1 0 00-.364 1.118l1.287 3.957c.299.92-.755 1.688-1.539 1.118l-3.366-2.446a1 1 0 00-1.176 0l-3.366 2.446c-.784.57-1.838-.197-1.539-1.118l1.287-3.957a1 1 0 00-.364-1.118L2.083 9.384c-.783-.57-.38-1.81.588-1.81h4.162a1 1 0 00.95-.69l1.286-3.957z" />
        </svg>
      ))}
    </div>
  )
}

function ReviewCard({ review }) {
  const [expanded, setExpanded] = useState(false)
  const text = review.text || ''
  const isLong = text.length > SEE_MORE_THRESHOLD

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm">
      <Stars count={Number(review.stars) || 0} />
      <p
        className={`mt-3 text-base text-gray-800 leading-relaxed ${
          isLong && !expanded ? 'line-clamp-4' : ''
        }`}
      >
        {text}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-2 text-sm font-semibold"
          style={{ color: 'var(--brand-color)' }}
        >
          {expanded ? 'See less' : 'See more'}
        </button>
      )}
      {review.customer_name && (
        <p className="mt-4 text-sm text-gray-500">— {review.customer_name}</p>
      )}
    </div>
  )
}

export default function Reviews({ reviews }) {
  return (
    <section className="bg-gray-50 py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8">
          What our guests are saying
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          {reviews.map((r, i) => (
            <ReviewCard key={i} review={r} />
          ))}
        </div>
      </div>
    </section>
  )
}
