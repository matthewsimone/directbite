import { formatCurrency } from '../utils/format'

export default function CartButton({ itemCount, total, onClick }) {
  if (itemCount === 0) return null

  return (
    <button
      onClick={onClick}
      className="fixed bottom-5 left-4 right-4 z-40 max-w-lg mx-auto bg-gray-900 text-white rounded-2xl px-5 py-4 flex items-center justify-between shadow-xl active:scale-[0.98] transition-transform"
    >
      <div className="text-left">
        <div className="font-bold text-base leading-tight">CHECKOUT</div>
        <div className="text-sm text-gray-300 mt-0.5">{formatCurrency(total)}</div>
      </div>
      <div className="w-9 h-9 rounded-full bg-[#16A34A] flex items-center justify-center font-bold text-sm">
        {itemCount}
      </div>
    </button>
  )
}
