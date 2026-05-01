import { Link } from 'react-router-dom'

export default function StickyMobileCTA({ restaurant }) {
  const target = `/${restaurant.slug}`
  return (
    <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 p-3 flex flex-col gap-2">
      <Link
        to={target}
        className="w-full text-center font-semibold py-3 rounded-full border-2 bg-white"
        style={{ borderColor: 'var(--brand-color)', color: 'var(--brand-color)' }}
      >
        See Menu
      </Link>
      <Link
        to={target}
        className="w-full text-center font-semibold py-3 rounded-full text-white"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        Order Online
      </Link>
    </div>
  )
}
