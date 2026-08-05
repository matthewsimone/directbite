import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'

function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }

const EARN_BASIS_OPTIONS = [
  { value: 'subtotal', label: 'Food subtotal' },
  { value: 'subtotal_less_discount', label: 'Subtotal less discount' },
  { value: 'total', label: 'Order total' },
]

// Seeded by "Create default tiers" when a restaurant has no tier rows yet.
// tier_level 1 is the floor every customer starts at, so its multiplier is
// 1.000 and its threshold is 0.
const DEFAULT_TIERS = [
  { tier_level: 1, name: 'Standard', color: '#6B7280', multiplier: 1.000, threshold_points: 0 },
  { tier_level: 2, name: 'Plus', color: '#16A34A', multiplier: 1.150, threshold_points: 500 },
  { tier_level: 3, name: 'Premium', color: '#111827', multiplier: 1.250, threshold_points: 2000 },
]

function ConfigPanel({ restaurant, onClose, onUpdate }) {
  const [enabled, setEnabled] = useState(restaurant.loyalty_enabled === true)
  const [pointsPerDollar, setPointsPerDollar] = useState(
    restaurant.loyalty_points_per_dollar == null ? '' : String(restaurant.loyalty_points_per_dollar)
  )
  const [earnBasis, setEarnBasis] = useState(restaurant.loyalty_earn_basis || 'subtotal')
  const [savingConfig, setSavingConfig] = useState(false)

  // null = not loaded yet, [] = loaded and empty.
  const [tiers, setTiers] = useState(null)
  const [savingTiers, setSavingTiers] = useState(false)
  const [creatingTiers, setCreatingTiers] = useState(false)
  const [transactions, setTransactions] = useState(null)

  // Tiers + activity are only meaningful once the program is switched on, so
  // the fetch is keyed to the SAVED flag rather than the local toggle state.
  // Re-runs when a save flips loyalty_enabled, because onUpdate feeds the
  // fresh row back down through the restaurant prop.
  useEffect(() => {
    if (!restaurant.loyalty_enabled) {
      setTiers(null)
      setTransactions(null)
      return
    }
    let cancelled = false
    setTiers(null)
    setTransactions(null)
    ;(async () => {
      const [tierRes, txRes] = await Promise.all([
        supabase
          .from('restaurant_loyalty_tiers')
          .select('id, tier_level, name, color, multiplier, threshold_points')
          .eq('restaurant_id', restaurant.id)
          .order('tier_level'),
        supabase
          .from('loyalty_transactions')
          .select('id, phone_e164, reason, points_delta, created_at')
          .eq('restaurant_id', restaurant.id)
          .order('created_at', { ascending: false })
          .limit(25),
      ])
      if (cancelled) return
      if (tierRes.error) toast.error(`Tier load failed: ${tierRes.error.message}`)
      if (txRes.error) toast.error(`Activity load failed: ${txRes.error.message}`)
      setTiers(tierRes.error ? [] : (tierRes.data || []))
      setTransactions(txRes.error ? [] : (txRes.data || []))
    })()
    return () => { cancelled = true }
  }, [restaurant.id, restaurant.loyalty_enabled])

  async function handleSaveConfig() {
    setSavingConfig(true)
    const { data, error } = await supabase
      .from('restaurants')
      .update({
        loyalty_enabled: enabled,
        loyalty_points_per_dollar: Number(pointsPerDollar) || 0,
        loyalty_earn_basis: earnBasis,
      })
      .eq('id', restaurant.id)
      .select()
      .single()
    setSavingConfig(false)
    if (error) {
      toast.error(`Loyalty save failed: ${error.message}`)
      return
    }
    toast.success('Loyalty settings saved')
    onUpdate(data)
  }

  async function handleCreateDefaults() {
    setCreatingTiers(true)
    const { data, error } = await supabase
      .from('restaurant_loyalty_tiers')
      .insert(DEFAULT_TIERS.map(t => ({ restaurant_id: restaurant.id, ...t })))
      .select('id, tier_level, name, color, multiplier, threshold_points')
    setCreatingTiers(false)
    if (error) {
      toast.error(`Tier create failed: ${error.message}`)
      return
    }
    toast.success('Default tiers created')
    setTiers([...(data || [])].sort((a, b) => a.tier_level - b.tier_level))
  }

  function updateTier(index, patch) {
    setTiers(prev => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  async function handleSaveTiers() {
    // Validated here rather than left to the column CHECK constraints, so a
    // bad value reads as a field error instead of a raw Postgres message.
    for (const t of tiers) {
      if (!t.name || !String(t.name).trim()) {
        toast.error(`Tier ${t.tier_level}: name is required`)
        return
      }
      const multiplier = Number(t.multiplier)
      if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
        toast.error(`Tier ${t.tier_level}: multiplier must be between 1.000 and 10.000`)
        return
      }
      const threshold = parseInt(t.threshold_points, 10)
      if (!Number.isFinite(threshold) || threshold < 0) {
        toast.error(`Tier ${t.tier_level}: threshold must be 0 or more`)
        return
      }
    }

    setSavingTiers(true)
    const results = await Promise.all(
      tiers.map(t =>
        supabase
          .from('restaurant_loyalty_tiers')
          .update({
            name: String(t.name).trim(),
            color: t.color,
            multiplier: Number(t.multiplier),
            threshold_points: parseInt(t.threshold_points, 10),
          })
          .eq('id', t.id)
      )
    )
    setSavingTiers(false)
    const failedIndex = results.findIndex(r => r.error)
    if (failedIndex !== -1) {
      toast.error(`Tier ${tiers[failedIndex].tier_level} save failed: ${results[failedIndex].error.message}`)
      return
    }
    toast.success('Tiers saved')
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-bold text-lg">{restaurant.name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none w-11 h-11 flex items-center justify-center">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* ── Section 1: program config ── */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Loyalty Program</h4>

          <button
            type="button"
            onClick={() => setEnabled(prev => !prev)}
            className={`w-full h-9 rounded-lg text-sm font-semibold border transition-colors ${
              enabled
                ? 'bg-[#16A34A] text-white border-[#16A34A] hover:bg-[#15803D]'
                : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {enabled ? 'Loyalty: On' : 'Loyalty: Off'}
          </button>

          {enabled && (
            <>
              <div>
                <label className="text-xs text-gray-500">Points per Dollar</label>
                <input
                  type="number" step="0.01" min="0"
                  value={pointsPerDollar}
                  onChange={e => setPointsPerDollar(e.target.value)}
                  className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500">Earn Basis</label>
                <select
                  value={earnBasis}
                  onChange={e => setEarnBasis(e.target.value)}
                  className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                >
                  {EARN_BASIS_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <button
            onClick={handleSaveConfig}
            disabled={savingConfig}
            className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D]"
          >
            {savingConfig ? 'Saving...' : 'Save Loyalty Settings'}
          </button>

          {enabled && !restaurant.loyalty_enabled && (
            <p className="text-xs text-gray-400">Save to configure tiers and view activity.</p>
          )}
        </div>

        {/* ── Section 2: tiers ── */}
        {restaurant.loyalty_enabled && (
          <>
            <hr />
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Tiers</h4>

              {tiers === null ? (
                <p className="text-gray-400 text-center mt-8">Loading...</p>
              ) : tiers.length === 0 ? (
                <button
                  onClick={handleCreateDefaults}
                  disabled={creatingTiers}
                  className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D]"
                >
                  {creatingTiers ? 'Creating...' : 'Create default tiers'}
                </button>
              ) : (
                <>
                  {tiers.map((t, i) => (
                    <div key={t.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-semibold text-gray-400">Tier {t.tier_level}</p>
                      <div>
                        <label className="text-xs text-gray-500">Name</label>
                        <input
                          type="text"
                          value={t.name || ''}
                          onChange={e => updateTier(i, { name: e.target.value })}
                          className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Color</label>
                        <input
                          type="color"
                          value={t.color || '#000000'}
                          onChange={e => updateTier(i, { color: e.target.value })}
                          className="w-full h-9 px-1 border border-gray-300 rounded-lg"
                        />
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">Multiplier</label>
                          <input
                            type="number" step="0.001" min="1" max="10"
                            value={t.multiplier ?? ''}
                            onChange={e => updateTier(i, { multiplier: e.target.value })}
                            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">Threshold Points</label>
                          <input
                            type="number" step="1" min="0"
                            value={t.threshold_points ?? ''}
                            onChange={e => updateTier(i, { threshold_points: e.target.value })}
                            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={handleSaveTiers}
                    disabled={savingTiers}
                    className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D]"
                  >
                    {savingTiers ? 'Saving...' : 'Save Tiers'}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Section 3: recent ledger activity (read-only) ── */}
        {restaurant.loyalty_enabled && (
          <>
            <hr />
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Recent Activity</h4>

              {transactions === null ? (
                <p className="text-gray-400 text-center mt-8">Loading...</p>
              ) : transactions.length === 0 ? (
                <p className="text-sm text-gray-400">No loyalty activity yet</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {transactions.map(t => (
                    <div key={t.id} className="py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{t.phone_e164}</p>
                        <p className="text-xs text-gray-400 truncate">{formatDate(t.created_at)} · {t.reason}</p>
                      </div>
                      <span className={`text-sm font-semibold shrink-0 ${t.points_delta < 0 ? 'text-red-600' : 'text-[#16A34A]'}`}>
                        {t.points_delta < 0 ? '-' : '+'}{Math.abs(t.points_delta)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function LoyaltyTab() {
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  useEffect(() => { fetchRestaurants() }, [])

  async function fetchRestaurants() {
    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, loyalty_enabled, loyalty_points_per_dollar, loyalty_earn_basis')
      .order('name')
    setLoading(false)
    if (error) {
      toast.error(`Failed to load restaurants: ${error.message}`)
      return
    }
    setRestaurants(data || [])
  }

  function handleUpdate(updated) {
    setRestaurants(prev => prev.map(r => (r.id === updated.id ? { ...r, ...updated } : r)))
    setSelected(prev => (prev ? { ...prev, ...updated } : prev))
  }

  return (
    <div className="h-full flex">
      <div className={`flex-1 overflow-y-auto p-4 md:p-6 ${selected ? 'md:max-w-[calc(100%-480px)]' : ''}`}>
        <h2 className="text-xl font-bold mb-4">Loyalty</h2>

        {loading ? (
          <p className="text-gray-400 text-center mt-8">Loading...</p>
        ) : restaurants.length === 0 ? (
          <p className="text-gray-400 text-center mt-8">No restaurants yet</p>
        ) : (
          <div className="space-y-3">
            {restaurants.map(r => (
              <div key={r.id}
                className={`bg-white rounded-lg border p-4 flex items-center justify-between gap-3 cursor-pointer hover:border-[#16A34A] transition-colors ${
                  selected?.id === r.id ? 'border-[#16A34A] ring-1 ring-[#16A34A]' : 'border-gray-200'
                }`}
                onClick={() => setSelected(r)}
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.name}</p>
                  <p className="text-sm text-gray-500 truncate">ordr.co/{r.slug}</p>
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
                  r.loyalty_enabled ? 'bg-green-50 text-[#16A34A]' : 'bg-gray-100 text-gray-400'
                }`}>
                  {r.loyalty_enabled ? 'Loyalty On' : 'Off'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="fixed inset-0 z-40 md:relative md:inset-auto md:z-auto md:w-[480px] md:shrink-0">
          <ConfigPanel
            key={selected.id}
            restaurant={selected}
            onClose={() => setSelected(null)}
            onUpdate={handleUpdate}
          />
        </div>
      )}
    </div>
  )
}
