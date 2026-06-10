import { formatCurrency } from '../utils/format'

export default function MenuItemCard({ item, lowestPrice, promotion, onClick }) {
  const unavailable = !item.is_available
  const hasDiscount = promotion && Number(promotion.discount_percentage) > 0
  const discountedPrice = hasDiscount
    ? lowestPrice * (1 - Number(promotion.discount_percentage) / 100)
    : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border border-gray-200 bg-white overflow-hidden transition-shadow ${
        unavailable
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:shadow-md cursor-pointer'
      }`}
      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
    >
      <div className="flex">
        <div className="flex-1 min-w-0 p-4">
          <div className="flex items-start gap-2">
            <h3 className="font-bold text-[15px] text-gray-900 leading-snug">{item.name}</h3>
            {item.is_best_seller && !unavailable && (
              <span className="shrink-0 text-[10px] font-semibold text-white bg-[#16A34A] px-1.5 py-0.5 rounded-full whitespace-nowrap">
                Best Seller
              </span>
            )}
            {unavailable && (
              <span className="shrink-0 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                Unavailable
              </span>
            )}
          </div>
          {item.description && (
            <p className="mt-1 text-[13px] text-gray-500 line-clamp-2">{item.description}</p>
          )}
          {lowestPrice != null && (
            <div className="mt-2 flex items-center gap-2">
              {hasDiscount ? (
                <>
                  <span className="text-[13px] text-gray-400 line-through">
                    {formatCurrency(lowestPrice)}
                  </span>
                  <span className="text-[15px] font-bold text-[#16A34A]">
                    {formatCurrency(discountedPrice)}
                  </span>
                </>
              ) : (
                <span className="text-[15px] font-bold text-gray-900">
                  {formatCurrency(lowestPrice)}
                </span>
              )}
            </div>
          )}
        </div>
        {item.image_url && (
          <div className="shrink-0 w-[110px]">
            <img
              src={item.image_url}
              alt={item.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}
      </div>
    </button>
  )
}
