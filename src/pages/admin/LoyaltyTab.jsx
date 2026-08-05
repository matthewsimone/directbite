import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'

function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function formatCents(c) { return `$${(Number(c || 0) / 100).toFixed(2)}` }
function formatMoney(v) { return `$${Number(v || 0).toFixed(2)}` }

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

// Catalog subtitle. Reads from the already-loaded menu_items array rather than
// re-querying — a reward whose item was deleted (menu_item_id goes null via
// ON DELETE SET NULL) falls back to a placeholder instead of blanking out.
function rewardSubtitle(rw, menuItems) {
  if (rw.kind === 'item') {
    const item = menuItems.find(i => i.id === rw.menu_item_id)
    const size = (item?.item_sizes || []).find(s => s.id === rw.item_size_id)
    const itemName = item?.name || 'Item no longer on the menu'
    return `Item · ${itemName}${size?.name ? ` (${size.name})` : ''}`
  }
  return `Discount · ${formatCents(rw.discount_cents)} off${Number(rw.min_subtotal_cents) > 0 ? ` · minimum ${formatCents(rw.min_subtotal_cents)}` : ''}`
}

// ── Reward Editor Panel ──
function RewardEditor({ reward, restaurantId, rewardCount, menuItems, categories, onClose, onSaved }) {
  const [kind, setKind] = useState(reward?.kind || 'item')
  const [name, setName] = useState(reward?.name || '')
  const [description, setDescription] = useState(reward?.description || '')
  const [pointsCost, setPointsCost] = useState(reward?.points_cost == null ? '' : String(reward.points_cost))
  const [menuItemId, setMenuItemId] = useState(reward?.menu_item_id || '')
  const [itemSizeId, setItemSizeId] = useState(reward?.item_size_id || '')
  const [discountDollars, setDiscountDollars] = useState(
    reward?.discount_cents == null ? '' : (Number(reward.discount_cents) / 100).toFixed(2)
  )
  const [minSubtotalDollars, setMinSubtotalDollars] = useState(
    reward ? (Number(reward.min_subtotal_cents || 0) / 100).toFixed(2) : ''
  )
  const [active, setActive] = useState(reward?.active ?? true)
  const [itemSearch, setItemSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const selectedItem = menuItems.find(i => i.id === menuItemId) || null
  const selectedSizes = (selectedItem?.item_sizes || []).slice().sort((a, b) => a.sort_order - b.sort_order)

  const search = itemSearch.trim().toLowerCase()
  const matchingItems = search
    ? menuItems.filter(i => (i.name || '').toLowerCase().includes(search))
    : menuItems

  function categoryName(catId) {
    return categories.find(c => c.id === catId)?.name || 'Uncategorized'
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Reward name is required')
      return
    }
    const points = parseInt(pointsCost, 10)
    if (!Number.isFinite(points) || points < 1) {
      toast.error('Points cost must be 1 or more')
      return
    }

    let discountCents = null
    let minCents = 0
    if (kind === 'item') {
      if (!menuItemId) {
        toast.error('Select a menu item for this reward')
        return
      }
    } else {
      discountCents = Math.round((Number(discountDollars) || 0) * 100)
      if (discountCents <= 0) {
        toast.error('Discount amount must be greater than $0.00')
        return
      }
      minCents = Math.round((Number(minSubtotalDollars) || 0) * 100)
      if (minCents < 0) {
        toast.error('Minimum subtotal cannot be negative')
        return
      }
    }

    // Mirrors the lr_shape_valid CHECK constraint: an item reward carries no
    // dollar amount, a discount reward carries no item.
    const payload = {
      kind,
      name: name.trim(),
      description: description.trim() || null,
      points_cost: points,
      menu_item_id: kind === 'item' ? menuItemId : null,
      item_size_id: kind === 'item' ? (itemSizeId || null) : null,
      discount_cents: kind === 'discount' ? discountCents : null,
      min_subtotal_cents: minCents,
      active,
    }

    setSaving(true)
    const { error } = reward
      ? await supabase.from('loyalty_rewards').update(payload).eq('id', reward.id)
      : await supabase.from('loyalty_rewards').insert({
          restaurant_id: restaurantId, sort_order: rewardCount, ...payload,
        })
    setSaving(false)

    if (error) {
      toast.error(`Reward save failed: ${error.message}`)
      return
    }
    toast.success(reward ? 'Reward saved' : 'Reward created')
    onSaved()
  }

  async function handleDelete() {
    if (!confirm('Delete this reward?')) return
    const { error } = await supabase.from('loyalty_rewards').delete().eq('id', reward.id)
    if (error) {
      toast.error(`Reward delete failed: ${error.message}`)
      return
    }
    toast.success('Reward deleted')
    onSaved()
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-bold">{reward ? 'Edit Reward' : 'New Reward'}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Kind is fixed once saved — flipping it would violate lr_shape_valid */}
        <div>
          <label className="text-xs text-gray-500">Reward Type</label>
          {reward ? (
            <p className="text-sm font-medium mt-1">{reward.kind === 'item' ? 'Item' : 'Discount'}</p>
          ) : (
            <div className="flex gap-2 mt-1">
              {['item', 'discount'].map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`flex-1 h-9 rounded-lg text-sm font-semibold border transition-colors ${
                    kind === k
                      ? 'bg-[#16A34A] text-white border-[#16A34A] hover:bg-[#15803D]'
                      : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {k === 'item' ? 'Item' : 'Discount'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="text-xs text-gray-500">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500">Description</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500">Points Cost</label>
          <input
            type="number" step="1" min="1"
            value={pointsCost}
            onChange={e => setPointsCost(e.target.value)}
            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
        </div>

        {kind === 'item' ? (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Menu Item</label>
            {selectedItem ? (
              <>
                <div className="flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{selectedItem.name}</p>
                    <p className="text-xs text-gray-400 truncate">{categoryName(selectedItem.category_id)}</p>
                  </div>
                  <button
                    onClick={() => { setMenuItemId(''); setItemSizeId(''); setItemSearch('') }}
                    className="text-xs text-[#16A34A] font-semibold shrink-0"
                  >
                    Change
                  </button>
                </div>
                {selectedSizes.length > 0 && (
                  <div className="mt-2">
                    <label className="text-xs text-gray-500">Size</label>
                    <select
                      value={itemSizeId}
                      onChange={e => setItemSizeId(e.target.value)}
                      className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                    >
                      <option value="">No specific size</option>
                      {selectedSizes.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name ? `${s.name} — ${formatMoney(s.price)}` : formatMoney(s.price)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={itemSearch}
                  onChange={e => setItemSearch(e.target.value)}
                  placeholder="Search menu items"
                  className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                />
                {matchingItems.length === 0 ? (
                  <p className="text-xs text-gray-400 mt-2">No menu items match</p>
                ) : (
                  <div className="mt-2 max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                    {matchingItems.map(i => (
                      <button
                        key={i.id}
                        onClick={() => { setMenuItemId(i.id); setItemSizeId('') }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                      >
                        <p className="text-sm font-medium truncate">{i.name}</p>
                        <p className="text-xs text-gray-400 truncate">{categoryName(i.category_id)}</p>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs text-gray-500">Discount Amount ($)</label>
              <input
                type="number" step="0.01" min="0.01"
                value={discountDollars}
                onChange={e => setDiscountDollars(e.target.value)}
                className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Minimum Subtotal ($)</label>
              <input
                type="number" step="0.01" min="0"
                value={minSubtotalDollars}
                onChange={e => setMinSubtotalDollars(e.target.value)}
                className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
          </>
        )}

        <button
          type="button"
          onClick={() => setActive(prev => !prev)}
          className={`w-full h-9 rounded-lg text-sm font-semibold border transition-colors ${
            active
              ? 'bg-[#16A34A] text-white border-[#16A34A] hover:bg-[#15803D]'
              : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-50'
          }`}
        >
          {active ? 'Active' : 'Inactive'}
        </button>
      </div>

      <div className="p-4 border-t space-y-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D]"
        >
          {saving ? 'Saving...' : 'Save Reward'}
        </button>
        {reward && (
          <button
            onClick={handleDelete}
            className="w-full h-10 border border-gray-300 text-red-500 font-semibold rounded-lg text-sm hover:bg-gray-50"
          >
            Delete Reward
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main Loyalty Tab ──
export default function LoyaltyTab() {
  const [restaurants, setRestaurants] = useState([])
  const [selectedRestaurant, setSelectedRestaurant] = useState('')
  const [loading, setLoading] = useState(false)

  const [tiers, setTiers] = useState([])
  const [rewards, setRewards] = useState([])
  const [menuItems, setMenuItems] = useState([])
  const [categories, setCategories] = useState([])
  const [transactions, setTransactions] = useState([])

  // Program config form — seeded from the selected restaurant row.
  const [enabled, setEnabled] = useState(false)
  const [pointsPerDollar, setPointsPerDollar] = useState('')
  const [earnBasis, setEarnBasis] = useState('subtotal')
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingTiers, setSavingTiers] = useState(false)
  const [creatingTiers, setCreatingTiers] = useState(false)

  // null = closed, 'new' = adding, object = editing that reward.
  const [editingReward, setEditingReward] = useState(null)

  const restaurant = restaurants.find(r => r.id === selectedRestaurant) || null
  // Tiers, rewards, and activity key off the SAVED flag, not the local toggle,
  // so nothing is configurable until the program is actually switched on.
  const loyaltyLive = restaurant?.loyalty_enabled === true

  useEffect(() => {
    supabase
      .from('restaurants')
      .select('id, name, slug, loyalty_enabled, loyalty_points_per_dollar, loyalty_earn_basis')
      .order('name')
      .then(({ data, error }) => {
        if (error) {
          toast.error(`Failed to load restaurants: ${error.message}`)
          return
        }
        setRestaurants(data || [])
      })
  }, [])

  // Depends on the restaurants array as well as the selection: the array
  // resolves asynchronously, so a selection made before that fetch settles
  // would find no matching row, seed the form from undefined, and a save
  // from that state would wipe the restaurant's loyalty config.
  useEffect(() => {
    if (!selectedRestaurant) return
    const r = restaurants.find(x => x.id === selectedRestaurant)
    setEnabled(r?.loyalty_enabled === true)
    setPointsPerDollar(r?.loyalty_points_per_dollar == null ? '' : String(r.loyalty_points_per_dollar))
    setEarnBasis(r?.loyalty_earn_basis || 'subtotal')
    fetchLoyalty()
  }, [selectedRestaurant, restaurants])

  async function fetchLoyalty() {
    setLoading(true)
    const [tierRes, rewardRes, itemRes, catRes, txRes] = await Promise.all([
      supabase
        .from('restaurant_loyalty_tiers')
        .select('id, tier_level, name, color, multiplier, threshold_points')
        .eq('restaurant_id', selectedRestaurant)
        .order('tier_level'),
      supabase
        .from('loyalty_rewards')
        .select('id, kind, name, description, points_cost, menu_item_id, item_size_id, discount_cents, min_subtotal_cents, active, sort_order')
        .eq('restaurant_id', selectedRestaurant)
        .order('sort_order'),
      supabase
        .from('menu_items')
        .select('id, name, category_id, item_sizes(*)')
        .eq('restaurant_id', selectedRestaurant)
        .order('sort_order'),
      supabase
        .from('menu_categories')
        .select('id, name')
        .eq('restaurant_id', selectedRestaurant),
      supabase
        .from('loyalty_transactions')
        .select('id, phone_e164, reason, points_delta, created_at')
        .eq('restaurant_id', selectedRestaurant)
        .order('created_at', { ascending: false })
        .limit(25),
    ])

    if (tierRes.error) toast.error(`Tier load failed: ${tierRes.error.message}`)
    if (rewardRes.error) toast.error(`Reward load failed: ${rewardRes.error.message}`)
    if (itemRes.error) toast.error(`Menu item load failed: ${itemRes.error.message}`)
    if (catRes.error) toast.error(`Category load failed: ${catRes.error.message}`)
    if (txRes.error) toast.error(`Activity load failed: ${txRes.error.message}`)

    setTiers(tierRes.data || [])
    setRewards(rewardRes.data || [])
    setMenuItems(itemRes.data || [])
    setCategories(catRes.data || [])
    setTransactions(txRes.data || [])
    setLoading(false)
  }

  async function handleSaveConfig() {
    setSavingConfig(true)
    const { data, error } = await supabase
      .from('restaurants')
      .update({
        loyalty_enabled: enabled,
        loyalty_points_per_dollar: Number(pointsPerDollar) || 0,
        loyalty_earn_basis: earnBasis,
      })
      .eq('id', selectedRestaurant)
      .select()
      .single()
    setSavingConfig(false)
    if (error) {
      toast.error(`Loyalty save failed: ${error.message}`)
      return
    }
    toast.success('Loyalty settings saved')
    setRestaurants(prev => prev.map(r => (r.id === data.id ? { ...r, ...data } : r)))
  }

  async function handleCreateDefaults() {
    setCreatingTiers(true)
    const { data, error } = await supabase
      .from('restaurant_loyalty_tiers')
      .insert(DEFAULT_TIERS.map(t => ({ restaurant_id: selectedRestaurant, ...t })))
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
    <div className="h-full flex">
      <div className={`flex-1 overflow-y-auto p-4 md:p-6 ${editingReward !== null ? 'md:max-w-[calc(100%-400px)]' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4">
          <h2 className="text-xl font-bold w-full md:w-auto">Loyalty</h2>
          <select value={selectedRestaurant} onChange={e => { setSelectedRestaurant(e.target.value); setEditingReward(null) }}
            className="h-11 md:h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white flex-1 md:flex-none min-w-0">
            <option value="">Select a restaurant...</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {selectedRestaurant && (
            <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
              loyaltyLive ? 'bg-green-50 text-[#16A34A]' : 'bg-gray-100 text-gray-400'
            }`}>
              {loyaltyLive ? 'Loyalty On' : 'Off'}
            </span>
          )}
        </div>

        {!selectedRestaurant ? (
          <p className="text-gray-400 text-center mt-8">Select a restaurant to configure loyalty</p>
        ) : loading ? (
          <p className="text-gray-400 text-center mt-8">Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* ── Section 1: program config ── */}
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="bg-gray-50 border-b px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Loyalty program</span>
              </div>
              <div className="p-4 space-y-3">
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
                  {savingConfig ? 'Saving...' : 'Save loyalty settings'}
                </button>

                {enabled && !loyaltyLive && (
                  <p className="text-xs text-gray-400">Save to configure tiers, rewards, and view activity.</p>
                )}
              </div>
            </div>

            {/* ── Section 2: tiers ── */}
            {loyaltyLive && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="bg-gray-50 border-b px-4 py-3">
                  <span className="text-sm font-semibold text-gray-900">Tiers</span>
                </div>
                <div className="p-4 space-y-3">
                  {tiers.length === 0 ? (
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
                        {savingTiers ? 'Saving...' : 'Save tiers'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Section 3: rewards catalog ── */}
            {loyaltyLive && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="bg-gray-50 border-b px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">Rewards catalog</span>
                  <button onClick={() => setEditingReward('new')} className="text-xs text-[#16A34A] font-semibold">Add reward</button>
                </div>
                <div className="p-4">
                  {rewards.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center">No rewards yet</p>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {rewards.map(rw => (
                        <div key={rw.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-medium truncate ${rw.active ? '' : 'text-gray-400'}`}>{rw.name}</p>
                            <p className="text-xs text-gray-400 truncate">{rewardSubtitle(rw, menuItems)}</p>
                          </div>
                          <span className={`text-sm font-semibold shrink-0 ${rw.active ? '' : 'text-gray-400'}`}>
                            {rw.points_cost} pts
                          </span>
                          <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
                            rw.active ? 'bg-green-50 text-[#16A34A]' : 'bg-gray-100 text-gray-400'
                          }`}>
                            {rw.active ? 'Active' : 'Inactive'}
                          </span>
                          <button onClick={() => setEditingReward(rw)} className="text-xs text-[#16A34A] font-semibold shrink-0">Edit</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Section 4: recent ledger activity (read-only) ── */}
            {loyaltyLive && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="bg-gray-50 border-b px-4 py-3">
                  <span className="text-sm font-semibold text-gray-900">Recent activity</span>
                </div>
                <div className="p-4">
                  {transactions.length === 0 ? (
                    <p className="text-sm text-gray-400">No loyalty activity yet</p>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {transactions.map(t => (
                        <div key={t.id} className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
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
              </div>
            )}
          </div>
        )}
      </div>

      {/* Side panel */}
      {editingReward !== null && (
        <div className="fixed inset-0 z-40 md:relative md:inset-auto md:z-auto md:w-[400px] md:shrink-0">
          <RewardEditor
            key={editingReward === 'new' ? 'new' : editingReward.id}
            reward={editingReward === 'new' ? null : editingReward}
            restaurantId={selectedRestaurant}
            rewardCount={rewards.length}
            menuItems={menuItems}
            categories={categories}
            onClose={() => setEditingReward(null)}
            onSaved={() => { setEditingReward(null); fetchLoyalty() }}
          />
        </div>
      )}
    </div>
  )
}
