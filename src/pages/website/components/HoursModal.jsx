import { useEffect, useState } from 'react'
import { isServiceConfigured, getWebsiteSchedules, getDisplayDays } from '../utils/hours'
import HoursDayList from './HoursDayList'

// Rows render Mon → Sun (getDisplayDays). Pickup/Delivery tabs appear only
// when the restaurant offers delivery on a different schedule than pickup.
const TABS = [
  { key: 'pickup', label: 'Pickup Hours' },
  { key: 'delivery', label: 'Delivery Hours' },
]

export default function HoursModal({ open, onClose, hours, restaurant }) {
  const today = new Date().getDay()
  const [tab, setTab] = useState('pickup')
  // Reset to Pickup whenever the modal closes, so it always reopens there.
  function close() {
    setTab('pickup')
    onClose()
  }

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!open) return null

  const configured = isServiceConfigured(restaurant)
  const showTabs = configured && getWebsiteSchedules(restaurant, hours).showDeliveryTab
  const days = getDisplayDays(restaurant, hours, showTabs ? tab : 'pickup')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold uppercase tracking-wide">Hours</h2>
          <button
            onClick={close}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            &times;
          </button>
        </div>

        {showTabs && (
          <div role="tablist" className="flex gap-6 px-6 border-b border-gray-100">
            {TABS.map(t => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                  tab === t.key
                    ? 'border-[var(--brand-color)] text-gray-900'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <HoursDayList days={days} variant="modal" today={today} configured={configured} />
      </div>
    </div>
  )
}
