import { useState, useEffect } from 'react'
import { formatCurrency } from '../utils/format'

export default function ItemModal({
  item,
  sizes,
  toppingGroupsForItem,
  getToppingsForGroup,
  promotion,
  onAddToCart,
  onClose,
}) {
  const [selectedSizeId, setSelectedSizeId] = useState(null)
  const [selectedToppings, setSelectedToppings] = useState([])
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [visible, setVisible] = useState(false)
  const [validationErrors, setValidationErrors] = useState([])

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  useEffect(() => {
    if (sizes.length > 0 && !selectedSizeId) {
      setSelectedSizeId(sizes[0].id)
    }
  }, [sizes, selectedSizeId])

  const selectedSize = sizes.find(s => s.id === selectedSizeId)
  const basePrice = selectedSize ? Number(selectedSize.price) : 0

  const toppingsTotal = selectedToppings.reduce((sum, t) => sum + Number(t.price), 0)

  const hasDiscount = promotion && Number(promotion.discount_percentage) > 0
  const rawItemPrice = basePrice + toppingsTotal
  const discountMultiplier = hasDiscount ? 1 - Number(promotion.discount_percentage) / 100 : 1
  const itemTotal = rawItemPrice * discountMultiplier * quantity

  // ── Pizza topping toggle (existing behavior) ──
  function handlePizzaToppingToggle(topping) {
    const existing = selectedToppings.find(t => t.toppingId === topping.id)
    if (existing) {
      setSelectedToppings(prev => prev.filter(t => t.toppingId !== topping.id))
    } else {
      setSelectedToppings(prev => [
        ...prev,
        {
          toppingId: topping.id,
          toppingName: topping.name,
          placement: 'whole',
          price: Number(topping.price),
          fullPrice: Number(topping.price),
          groupId: topping.topping_group_id,
        },
      ])
    }
  }

  function handlePlacementChange(toppingId, placement) {
    setSelectedToppings(prev =>
      prev.map(t => {
        if (t.toppingId !== toppingId) return t
        const price = placement === 'whole' ? t.fullPrice : t.fullPrice / 2
        return { ...t, placement, price: Math.round(price * 100) / 100 }
      })
    )
  }

  // ── Addon toggle (new behavior) ──
  function handleAddonToggle(topping, group) {
    const existing = selectedToppings.find(t => t.toppingId === topping.id)
    if (existing) {
      setSelectedToppings(prev => prev.filter(t => t.toppingId !== topping.id))
    } else {
      // Enforce max_selections
      if (group.max_selections) {
        const currentCount = selectedToppings.filter(t => t.groupId === group.id).length
        if (currentCount >= group.max_selections) return
      }
      setSelectedToppings(prev => [
        ...prev,
        {
          toppingId: topping.id,
          toppingName: topping.name,
          placement: 'whole', // addons always stored as whole
          price: Number(topping.price),
          fullPrice: Number(topping.price),
          groupId: group.id,
        },
      ])
    }
  }

  function validate() {
    const errors = []
    for (const group of toppingGroupsForItem) {
      if (group.placement_type === 'addon' && group.required) {
        const count = selectedToppings.filter(t => t.groupId === group.id).length
        if (count === 0) {
          errors.push(`Please select from "${group.name}"`)
        }
      }
    }
    return errors
  }

  function handleAdd() {
    const errors = validate()
    if (errors.length > 0) {
      setValidationErrors(errors)
      return
    }
    setValidationErrors([])

    onAddToCart({
      menuItemId: item.id,
      itemSizeId: selectedSizeId,
      itemName: item.name,
      sizeName: selectedSize?.name || null,
      basePrice: basePrice * discountMultiplier,
      quantity,
      specialInstructions: specialInstructions.trim() || null,
      toppings: selectedToppings.map(t => {
        const group = toppingGroupsForItem.find(g => g.id === t.groupId)
        return {
          toppingId: t.toppingId,
          toppingName: t.toppingName,
          placement: t.placement,
          price: t.price * discountMultiplier,
          placementType: group?.placement_type || 'pizza',
        }
      }),
    })
    handleClose()
  }

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 300)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={handleClose}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black transition-opacity duration-300 ${
          visible ? 'opacity-50' : 'opacity-0'
        }`}
      />

      {/* Sheet */}
      <div
        onClick={e => e.stopPropagation()}
        className={`relative w-full max-w-lg bg-white rounded-t-2xl max-h-[90vh] flex flex-col transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-300 rounded-full" />
        </div>

        <div className="overflow-y-auto flex-1 px-5 pb-4">
          {/* Item photo */}
          {item.image_url && (
            <div className="w-full h-48 rounded-xl overflow-hidden mb-4 bg-gray-100">
              <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
            </div>
          )}

          {/* Name & description */}
          <h2 className="text-2xl font-bold text-gray-900">{item.name}</h2>
          {item.description && (
            <p className="mt-1 text-gray-500">{item.description}</p>
          )}

          {/* Size selection */}
          {sizes.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Size
              </h3>
              <div className="space-y-2">
                {sizes.map(size => (
                  <label
                    key={size.id}
                    className={`flex items-center justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-colors ${
                      selectedSizeId === size.id
                        ? 'border-[#16A34A] bg-green-50/50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                          selectedSizeId === size.id ? 'border-[#16A34A]' : 'border-gray-300'
                        }`}
                      >
                        {selectedSizeId === size.id && (
                          <div className="w-2.5 h-2.5 rounded-full bg-[#16A34A]" />
                        )}
                      </div>
                      <span className="font-medium text-gray-900">{size.name}</span>
                    </div>
                    <span className="font-semibold text-gray-900">{formatCurrency(size.price)}</span>
                    <input
                      type="radio"
                      className="sr-only"
                      name="size"
                      checked={selectedSizeId === size.id}
                      onChange={() => setSelectedSizeId(size.id)}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Topping groups — render based on placement_type */}
          {toppingGroupsForItem.map(group => {
            const groupToppings = getToppingsForGroup(group.id).filter(t => t.is_available)
            if (groupToppings.length === 0) return null
            const isPizza = group.placement_type !== 'addon'

            if (isPizza) {
              return <PizzaToppingGroup
                key={group.id}
                group={group}
                groupToppings={groupToppings}
                selectedToppings={selectedToppings}
                onToggle={handlePizzaToppingToggle}
                onPlacementChange={handlePlacementChange}
              />
            }

            return <AddonGroup
              key={group.id}
              group={group}
              groupToppings={groupToppings}
              selectedToppings={selectedToppings}
              onToggle={topping => handleAddonToggle(topping, group)}
            />
          })}

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3">
              {validationErrors.map((err, i) => (
                <p key={i} className="text-sm text-red-600">{err}</p>
              ))}
            </div>
          )}

          {/* Special instructions */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
              Special Instructions
            </h3>
            <textarea
              value={specialInstructions}
              onChange={e => setSpecialInstructions(e.target.value)}
              placeholder="e.g. no salt, no onions"
              rows={3}
              className="w-full px-4 py-3 bg-gray-100 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
            />
            <p className="mt-1.5 text-xs text-gray-400">
              NOTE: Additional items entered here may cost extra and we will need to charge after the order is completed.
            </p>
          </div>

          {/* Quantity */}
          <div className="mt-6 flex items-center justify-center gap-4">
            <button
              onClick={() => setQuantity(q => Math.max(1, q - 1))}
              className="w-11 h-11 rounded-full border-2 border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            <span className="text-xl font-bold w-8 text-center">{quantity}</span>
            <button
              onClick={() => setQuantity(q => q + 1)}
              className="w-11 h-11 rounded-full border-2 border-[#16A34A] text-[#16A34A] flex items-center justify-center hover:bg-green-50 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        </div>

        {/* Add to cart button */}
        <div className="px-5 py-4 border-t border-gray-100">
          <button
            onClick={handleAdd}
            className="w-full bg-[#16A34A] text-white font-bold text-lg py-4 rounded-xl active:scale-[0.98] transition-transform"
          >
            Add to Cart — {formatCurrency(itemTotal)}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Pizza Topping Group (existing behavior) ──
function PizzaToppingGroup({ group, groupToppings, selectedToppings, onToggle, onPlacementChange }) {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
        {group.name}
      </h3>
      <div className="space-y-2">
        {groupToppings.map(topping => {
          const selected = selectedToppings.find(t => t.toppingId === topping.id)
          return (
            <div key={topping.id}>
              <button
                onClick={() => onToggle(topping)}
                className={`w-full flex items-center justify-between p-3.5 rounded-xl border-2 transition-colors ${
                  selected
                    ? 'border-[#16A34A] bg-green-50/50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="font-medium text-gray-900">{topping.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">+{formatCurrency(topping.price)}</span>
                  {!selected && (
                    <div className="w-7 h-7 rounded-full bg-[#16A34A] flex items-center justify-center">
                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                      </svg>
                    </div>
                  )}
                </div>
              </button>

              {selected && (
                <div className="flex gap-2 mt-2 ml-4">
                  {['left', 'whole', 'right'].map(p => (
                    <button
                      key={p}
                      onClick={() => onPlacementChange(topping.id, p)}
                      className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium capitalize transition-colors ${
                        selected.placement === p
                          ? 'bg-[#16A34A] text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {p}
                      <span className="block text-xs mt-0.5 opacity-80">
                        {p === 'whole'
                          ? formatCurrency(topping.price)
                          : formatCurrency(topping.price / 2)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Addon Group (new behavior) ──
function AddonGroup({ group, groupToppings, selectedToppings, onToggle }) {
  const selectedCount = selectedToppings.filter(t => t.groupId === group.id).length

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          {group.name}
        </h3>
        {group.required && (
          <span className="text-xs font-semibold text-red-500 bg-red-50 px-1.5 py-0.5 rounded">Required</span>
        )}
        {group.max_selections && (
          <span className="text-xs text-gray-400">Pick up to {group.max_selections}</span>
        )}
      </div>
      <div className="space-y-2">
        {groupToppings.map(topping => {
          const selected = selectedToppings.find(t => t.toppingId === topping.id)
          const atMax = group.max_selections && selectedCount >= group.max_selections && !selected
          const priceNum = Number(topping.price)

          return (
            <button
              key={topping.id}
              onClick={() => !atMax && onToggle(topping)}
              className={`w-full flex items-center justify-between p-3.5 rounded-xl border-2 transition-colors ${
                selected
                  ? 'border-[#16A34A] bg-green-50/50'
                  : atMax
                    ? 'border-gray-100 opacity-40 cursor-not-allowed'
                    : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Checkbox indicator */}
                <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  selected ? 'bg-[#16A34A]' : 'border-2 border-gray-300'
                }`}>
                  {selected && (
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <span className="font-medium text-gray-900">{topping.name}</span>
              </div>
              <span className={`text-sm ${priceNum === 0 ? 'text-[#16A34A] font-medium' : 'text-gray-600'}`}>
                {priceNum === 0 ? 'Free' : `+${formatCurrency(priceNum)}`}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
