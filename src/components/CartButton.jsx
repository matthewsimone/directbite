import { useState, useEffect, useRef } from 'react'
import { formatCurrency } from '../utils/format'
import { formatPoints } from '../utils/loyaltyPoints'

export default function CartButton({ itemCount, total, onClick, pointsDelta }) {
  const [pulse, setPulse] = useState(false)
  const [float, setFloat] = useState(null)
  const prevCount = useRef(itemCount)

  useEffect(() => {
    if (itemCount > prevCount.current) {
      setPulse(true)
      const timer = setTimeout(() => setPulse(false), 600)
      return () => clearTimeout(timer)
    }
    prevCount.current = itemCount
  }, [itemCount])

  useEffect(() => {
    prevCount.current = itemCount
  }, [itemCount])

  // The key remounts the span so the CSS animation replays — without it a
  // second add of the same value would render an already-finished animation.
  useEffect(() => {
    if (!(Number(pointsDelta) > 0)) return
    setFloat({ value: pointsDelta, key: Date.now() })
    const timer = setTimeout(() => setFloat(null), 1200)
    return () => clearTimeout(timer)
  }, [pointsDelta])

  if (itemCount === 0) return null

  return (
    <button
      onClick={onClick}
      className={`fixed bottom-5 left-4 right-4 z-40 max-w-lg mx-auto bg-gray-900 text-white rounded-2xl px-5 py-4 flex items-center justify-between shadow-xl active:scale-[0.98] transition-transform relative ${
        pulse ? 'animate-cart-pulse' : ''
      }`}
    >
      {float && (
        <span
          key={float.key}
          className="absolute left-1/2 -top-2 text-lg font-bold text-[#16A34A] pointer-events-none animate-points-float"
        >
          +{formatPoints(float.value)} points
        </span>
      )}

      <div className="text-left">
        <div className="font-bold text-base leading-tight">CHECKOUT</div>
        <div className="text-sm text-gray-300 mt-0.5">{formatCurrency(total)}</div>
      </div>
      <div className={`w-9 h-9 rounded-full bg-[#16A34A] flex items-center justify-center font-bold text-sm transition-transform ${
        pulse ? 'scale-125' : ''
      }`}>
        {itemCount}
      </div>
    </button>
  )
}
