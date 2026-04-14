export default function PromotionBanner({ promotion }) {
  if (!promotion) return null

  return (
    <div className="bg-[#16A34A] text-white text-center text-sm font-semibold py-2.5 px-4"
      style={{ boxShadow: '0 -50vh 0 50vh #ffffff' }}
    >
      🎉 {Number(promotion.discount_percentage)}% off when you order direct!
    </div>
  )
}
