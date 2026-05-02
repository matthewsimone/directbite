export default function PromoBar({ promotion }) {
  if (!promotion) return null
  const pct = Number(promotion.discount_percentage)
  return (
    <div
      className="relative z-40 text-white text-center text-sm font-semibold pb-2.5 px-4"
      style={{
        backgroundColor: 'var(--brand-color)',
        paddingTop: 'max(10px, env(safe-area-inset-top))',
      }}
    >
      {pct}% OFF Online Only
    </div>
  )
}
