export default function PromoBar({ promotion }) {
  if (!promotion) return null
  const pct = Number(promotion.discount_percentage)
  return (
    <div
      className="text-white text-center text-sm font-semibold py-2.5 px-4"
      style={{ backgroundColor: 'var(--brand-color)' }}
    >
      {pct}% OFF Online Only
    </div>
  )
}
