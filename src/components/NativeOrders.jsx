// Native-only Orders tab. Presentational — same data and logic as
// AccountView's orderList; AccountView owns expand/reorder state and passes
// it in. Rendered only when IS_NATIVE && section === 'orders'.

import { formatDay, formatPoints, titleCase } from './rewardsShared'

export default function NativeOrders({
  orders = [],
  transactions = [],
  loyaltyEnabled = false,
  historyLoading = false,
  historyFailed = false,
  onRetryHistory = () => {},
  onStartOrder = () => {},
  brandColor,
  expandedOrders = new Set(),
  onToggleExpand = () => {},
  reorderingId = null,
  onReorderClick = () => {},
}) {
  const stateButton = 'h-12 px-6 rounded-xl text-base font-semibold text-white mt-4'

  let body
  if (historyLoading) {
    body = (
      <div className="text-center px-5 py-16">
        <p className="text-base text-gray-600">Loading your orders...</p>
      </div>
    )
  } else if (historyFailed) {
    // Above the empty check: a failed fetch leaves orders at [], which would
    // otherwise read as "you have never ordered here".
    body = (
      <div className="text-center px-5 py-16">
        <p className="text-base text-gray-600">Couldn't load your orders.</p>
        <p className="text-base text-gray-600 mt-1">Your connection looks unstable.</p>
        <button
          type="button"
          onClick={onRetryHistory}
          className={stateButton}
          style={{ backgroundColor: brandColor }}
        >
          Try again
        </button>
      </div>
    )
  } else if (orders.length === 0) {
    body = (
      <div className="text-center px-5 py-16">
        <p className="text-base text-gray-600">Your past orders will show up here.</p>
        <button
          type="button"
          onClick={onStartOrder}
          className={stateButton}
          style={{ backgroundColor: brandColor }}
        >
          Start an order
        </button>
      </div>
    )
  } else {
    body = orders.map((order, i) => {
      const earned = loyaltyEnabled
        ? transactions.find(t => t.order_id === order.id && Number(t.points_delta) > 0)
        : null
      const orderItems = order.order_items || []
      const expanded = expandedOrders.has(order.id)
      const visibleItems = expanded ? orderItems : orderItems.slice(0, 3)
      const hiddenCount = orderItems.length - visibleItems.length
      const reordering = reorderingId === order.id

      return (
        <div key={order.id} className={`bg-white rounded-2xl mx-5 p-4 border border-gray-200 shadow-sm ${i < orders.length - 1 ? 'mb-3' : ''}`}>
          <div className="flex justify-between items-center gap-3">
            <p className="text-base font-semibold text-gray-900">{formatDay(order.created_at)}</p>
            <p className="text-sm text-gray-500 shrink-0">
              {`${titleCase(order.order_type)} · $${Number(order.total_amount || 0).toFixed(2)}`}
            </p>
          </div>

          <div className="mt-2">
            {visibleItems.map(item => {
              const itemToppings = item.order_item_toppings || []
              return (
                <div key={item.id}>
                  <p className="text-[15px] text-gray-900 leading-snug">{`${item.quantity}× ${item.item_name}`}</p>
                  {itemToppings.length > 0 && (
                    <p className="text-[13px] text-gray-500">
                      {itemToppings
                        .map(t =>
                          t.placement === 'whole'
                            ? t.topping_name
                            : `${titleCase(t.placement)}: ${t.topping_name}`
                        )
                        .join(', ')}
                    </p>
                  )}
                </div>
              )
            })}
            {(hiddenCount > 0 || expanded) && (
              <button
                type="button"
                onClick={() => onToggleExpand(order.id)}
                className="text-sm font-medium mt-1"
                style={{ color: brandColor }}
              >
                {expanded ? 'Show less' : `+${hiddenCount} more items`}
              </button>
            )}
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between items-center">
            {earned ? (
              <span className="text-sm font-semibold" style={{ color: brandColor }}>
                {`+${formatPoints(earned.points_delta)} points`}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              disabled={reordering}
              onClick={() => onReorderClick(order)}
              className="h-11 px-5 rounded-xl text-[15px] font-semibold text-white"
              style={{ backgroundColor: brandColor }}
            >
              {reordering ? 'Adding...' : 'Reorder'}
            </button>
          </div>
        </div>
      )
    })
  }

  return (
    <div className="-mx-6 -mt-2 -mb-8 bg-white min-h-[70vh] pt-6 pb-0">
      <h1 className="text-2xl font-bold text-gray-900 px-5 mb-4">Orders</h1>
      {body}
    </div>
  )
}
