import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

export default function PromotionsTab({ restaurant }) {
  const [promotion, setPromotion] = useState(null)
  const [isActive, setIsActive] = useState(false)
  const [percentage, setPercentage] = useState('')
  const [durationType, setDurationType] = useState('perpetual')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchPromotion()
  }, [restaurant?.id])

  async function fetchPromotion() {
    if (!restaurant) return

    const { data } = await supabase
      .from('promotions')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (data) {
      setPromotion(data)
      setIsActive(data.is_active)
      setPercentage(String(data.discount_percentage))
      setDurationType(data.is_perpetual ? 'perpetual' : 'date_range')
      setStartDate(data.start_date || '')
      setEndDate(data.end_date || '')
    }
    setLoading(false)
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)

    const payload = {
      restaurant_id: restaurant.id,
      is_active: isActive,
      discount_percentage: parseFloat(percentage) || 0,
      is_perpetual: durationType === 'perpetual',
      start_date: durationType === 'date_range' ? startDate || null : null,
      end_date: durationType === 'date_range' ? endDate || null : null,
    }

    if (promotion) {
      await supabase
        .from('promotions')
        .update(payload)
        .eq('id', promotion.id)
    } else {
      const { data } = await supabase
        .from('promotions')
        .insert(payload)
        .select()
        .single()

      if (data) setPromotion(data)
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function getPreviewText() {
    const pct = parseFloat(percentage) || 0
    if (pct === 0) return ''
    if (durationType === 'perpetual') {
      return `${pct}% off all orders (perpetual)`
    }
    const from = startDate ? new Date(startDate + 'T00:00:00').toLocaleDateString() : '...'
    const to = endDate ? new Date(endDate + 'T00:00:00').toLocaleDateString() : '...'
    return `${pct}% off all orders from ${from} to ${to}`
  }

  if (loading) {
    return <p className="text-center text-gray-400 mt-8">Loading promotions...</p>
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-lg mx-auto space-y-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Direct Discount</h3>

        {/* Active toggle */}
        <div className="flex items-center justify-between">
          <span className="font-medium text-base">Status</span>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium ${isActive ? 'text-[#16A34A]' : 'text-gray-400'}`}>
              {isActive ? 'Active' : 'Inactive'}
            </span>
            <button
              onClick={() => setIsActive(!isActive)}
              className={`relative w-14 h-8 rounded-full transition-colors ${
                isActive ? 'bg-[#16A34A]' : 'bg-gray-300'
              }`}
            >
              <span
                className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                  isActive ? 'left-7' : 'left-1'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Discount percentage */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Discount Percentage</label>
          <div className="relative">
            <input
              type="number"
              min="0"
              max="100"
              value={percentage}
              onChange={e => setPercentage(e.target.value)}
              className="w-full h-12 px-4 pr-8 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              placeholder="0"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">%</span>
          </div>
        </div>

        {/* Duration */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Duration</label>
          <div className="flex gap-3">
            <button
              onClick={() => setDurationType('perpetual')}
              className={`flex-1 h-12 rounded-xl font-semibold transition-colors ${
                durationType === 'perpetual'
                  ? 'bg-[#16A34A] text-white'
                  : 'border border-gray-300 text-gray-700'
              }`}
            >
              Perpetual
            </button>
            <button
              onClick={() => setDurationType('date_range')}
              className={`flex-1 h-12 rounded-xl font-semibold transition-colors ${
                durationType === 'date_range'
                  ? 'bg-[#16A34A] text-white'
                  : 'border border-gray-300 text-gray-700'
              }`}
            >
              Date Range
            </button>
          </div>
        </div>

        {/* Date range inputs */}
        {durationType === 'date_range' && (
          <div className="grid grid-cols-2 gap-3" style={{ maxWidth: '100%' }}>
            <div className="min-w-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full h-12 px-2 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div className="min-w-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full h-12 px-2 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
          </div>
        )}

        {/* Preview */}
        {getPreviewText() && (
          <div className="bg-green-50 p-4 rounded-xl">
            <p className="text-sm text-green-800 font-medium">{getPreviewText()}</p>
          </div>
        )}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full h-14 bg-[#16A34A] text-white font-bold text-base rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save Promotion'}
        </button>
      </div>
    </div>
  )
}
