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
      disabled={false}
      className={`w-full flex gap-3 p-4 rounded-xl text-left transition-all active:scale-[0.98] ${
        unavailable ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50 cursor-pointer'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <h3 className="font-semibold text-gray-900 text-base leading-tight">{item.name}</h3>
          {unavailable && (
            <span className="shrink-0 text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
              Unavailable
            </span>
          )}
        </div>
        {item.description && (
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">{item.description}</p>
        )}
        {lowestPrice != null && (
          <div className="mt-2 flex items-center gap-2">
            {hasDiscount ? (
              <>
                <span className="text-sm text-gray-400 line-through">
                  {formatCurrency(lowestPrice)}
                </span>
                <span className="text-sm font-semibold text-[#16A34A]">
                  {formatCurrency(discountedPrice)}
                </span>
              </>
            ) : (
              <span className="text-sm font-semibold text-gray-900">
                {formatCurrency(lowestPrice)}
              </span>
            )}
          </div>
        )}
      </div>
      {item.image_url && (
        <div className="shrink-0 w-24 h-24 rounded-lg overflow-hidden bg-gray-100">
          <img
            src={item.image_url}
            alt={item.name}
            className="w-full h-full object-cover"
          />
        </div>
      )}
    </button>
  )
}
