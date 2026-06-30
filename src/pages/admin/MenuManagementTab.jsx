import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'
import MenuImportModal from '../../components/MenuImportModal'

function formatMoney(v) { return `$${Number(v).toFixed(2)}` }

// ── Item Editor Panel ──
const FEATURED_LIMIT = 8

function ItemEditor({ item, categoryId, restaurantId, restaurantSlug, toppingGroups, featuredCount, onClose, onSaved }) {
  const [name, setName] = useState(item?.name || '')
  const [description, setDescription] = useState(item?.description || '')
  const [imageUrl, setImageUrl] = useState(item?.image_url || '')
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [isBestSeller, setIsBestSeller] = useState(item?.is_best_seller ?? false)
  const [isPopular, setIsPopular] = useState(item?.is_popular ?? false)
  const [featuredOnWebsite, setFeaturedOnWebsite] = useState(item?.featured_on_website ?? false)
  const [sizes, setSizes] = useState([])
  const [assignedGroupIds, setAssignedGroupIds] = useState([])
  const [dragLinkId, setDragLinkId] = useState(null)
  const [dragOverLinkId, setDragOverLinkId] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (item) {
      fetchItemDetails()
    } else {
      setSizes([{ name: '', price: '', sort_order: 0, _key: Math.random().toString(36).slice(2) }])
    }
  }, [item?.id])

  async function fetchItemDetails() {
    const [sizesRes, groupsRes] = await Promise.all([
      supabase.from('item_sizes').select('*').eq('item_id', item.id).order('sort_order'),
      supabase.from('item_topping_groups').select('topping_group_id, sort_order').eq('item_id', item.id).order('sort_order'),
    ])
    setSizes((sizesRes.data || []).map(s => ({ ...s, _key: s.id })))
    setAssignedGroupIds((groupsRes.data || []).map(g => g.topping_group_id))
  }

  function addSize() {
    setSizes(prev => [...prev, { name: '', price: '', sort_order: prev.length, _key: Math.random().toString(36).slice(2) }])
  }

  function removeSize(key) {
    setSizes(prev => prev.filter(s => s._key !== key))
  }

  function updateSize(key, field, value) {
    setSizes(prev => prev.map(s => s._key === key ? { ...s, [field]: value } : s))
  }

  function addGroup(groupId) {
    setAssignedGroupIds(prev => prev.includes(groupId) ? prev : [...prev, groupId])
  }

  function removeGroup(groupId) {
    setAssignedGroupIds(prev => prev.filter(id => id !== groupId))
  }

  // Local drag-reorder of assigned topping groups. Final sort_order is
  // persisted by handleSave's wipe-and-reinsert path below, mirroring how
  // sizes are persisted in this same editor (sort_order = array index).
  function handleLinkDrop(targetGroupId) {
    if (!dragLinkId || dragLinkId === targetGroupId) return
    const dragIdx = assignedGroupIds.indexOf(dragLinkId)
    const targetIdx = assignedGroupIds.indexOf(targetGroupId)
    if (dragIdx === -1 || targetIdx === -1) return
    const reordered = [...assignedGroupIds]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(targetIdx, 0, moved)
    setAssignedGroupIds(reordered)
    setDragLinkId(null)
    setDragOverLinkId(null)
  }

  async function handleSave() {
    if (!name.trim()) return
    // Enforce 8-item featured limit when turning on
    const wasFeatured = item?.featured_on_website ?? false
    if (featuredOnWebsite && !wasFeatured && featuredCount >= FEATURED_LIMIT) {
      toast.error('Feature limit reached. Unfeature another item first.')
      return
    }
    setSaving(true)

    let itemId = item?.id

    // Compute featured_order: keep existing if already featured; assign next slot if newly featured; null if disabled
    let nextFeaturedOrder = item?.featured_order ?? null
    if (featuredOnWebsite && !wasFeatured) {
      nextFeaturedOrder = featuredCount // 0-indexed, fits before the limit
    } else if (!featuredOnWebsite) {
      nextFeaturedOrder = null
    }

    const baseFields = {
      name, description, image_url: imageUrl || null,
      is_available: isAvailable, is_best_seller: isBestSeller, is_popular: isPopular,
      featured_on_website: featuredOnWebsite, featured_order: nextFeaturedOrder,
    }

    if (item) {
      await supabase.from('menu_items').update(baseFields).eq('id', item.id)
    } else {
      const { data } = await supabase.from('menu_items').insert({
        restaurant_id: restaurantId, category_id: categoryId, sort_order: 0,
        ...baseFields,
      }).select().single()
      if (data) itemId = data.id
    }

    if (!itemId) { setSaving(false); return }

    // Sync sizes: update existing, insert new, delete removed
    const validSizes = sizes.filter(s => s.price !== '' && s.price !== undefined && s.price !== null)
    const existingSizeIds = validSizes.filter(s => s.id).map(s => s.id)

    // Delete sizes that were removed (only those not referenced by orders)
    const { data: currentSizes } = await supabase.from('item_sizes').select('id').eq('item_id', itemId)
    const sizeIdsToDelete = (currentSizes || []).map(s => s.id).filter(id => !existingSizeIds.includes(id))
    for (const id of sizeIdsToDelete) {
      await supabase.from('item_sizes').delete().eq('id', id)
    }

    // Upsert sizes
    for (let i = 0; i < validSizes.length; i++) {
      const s = validSizes[i]
      if (s.id) {
        await supabase.from('item_sizes').update({ name: s.name.trim() || '', price: parseFloat(s.price), sort_order: i }).eq('id', s.id)
      } else {
        await supabase.from('item_sizes').insert({ item_id: itemId, name: s.name.trim() || '', price: parseFloat(s.price), sort_order: i })
      }
    }

    // Sync topping group assignments: safe to delete-reinsert (no FK from orders)
    await supabase.from('item_topping_groups').delete().eq('item_id', itemId)
    if (assignedGroupIds.length > 0) {
      await supabase.from('item_topping_groups').insert(
        assignedGroupIds.map((gId, i) => ({ item_id: itemId, topping_group_id: gId, sort_order: i }))
      )
    }

    setSaving(false)
    onSaved()
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-bold">{item ? 'Edit Item' : 'New Item'}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-xs text-gray-500">Name</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Item Photo</label>
          <ImageUpload
            currentImageUrl={imageUrl}
            bucketName="menu-images"
            storagePath={`${restaurantSlug}/${item?.id || 'new'}.jpg`}
            onUpload={url => setImageUrl(url)}
            placeholder="Upload Photo"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Available</span>
          <button onClick={() => setIsAvailable(!isAvailable)}
            className={`relative w-12 h-7 rounded-full transition-colors ${isAvailable ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${isAvailable ? 'left-5.5' : 'left-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Best Seller</span>
          <button onClick={() => setIsBestSeller(!isBestSeller)}
            className={`relative w-12 h-7 rounded-full transition-colors ${isBestSeller ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${isBestSeller ? 'left-5.5' : 'left-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Popular Item</span>
          <button onClick={() => setIsPopular(!isPopular)}
            className={`relative w-12 h-7 rounded-full transition-colors ${isPopular ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${isPopular ? 'left-5.5' : 'left-0.5'}`} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Feature on Website</span>
            <button onClick={() => setFeaturedOnWebsite(!featuredOnWebsite)}
              className={`relative w-12 h-7 rounded-full transition-colors ${featuredOnWebsite ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${featuredOnWebsite ? 'left-5.5' : 'left-0.5'}`} />
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">Featured on website: {featuredCount} / {FEATURED_LIMIT}</p>
        </div>

        {/* Sizes / Pricing */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-500 uppercase font-semibold">Pricing</label>
            <button onClick={addSize} className="text-xs text-[#16A34A] font-semibold">+ Add Size</button>
          </div>
          <p className="text-xs text-gray-400 mb-2">Leave size name blank for single-price items</p>
          {sizes.map(s => (
            <div key={s._key} className="flex gap-2 mb-2">
              <input value={s.name} onChange={e => updateSize(s._key, 'name', e.target.value)}
                placeholder="Size name (optional)" className="flex-1 h-9 px-3 border border-gray-300 rounded-lg text-sm" />
              <div className="relative w-24">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" step="0.01" value={s.price} onChange={e => updateSize(s._key, 'price', e.target.value)}
                  placeholder="0.00" className="w-full h-9 pl-6 pr-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <button onClick={() => removeSize(s._key)} className="text-red-400 hover:text-red-600 text-lg px-1">&times;</button>
            </div>
          ))}
        </div>

        {/* Topping groups — assigned (drag to reorder) + available */}
        <div>
          <label className="text-xs text-gray-500 uppercase font-semibold mb-2 block">Topping Groups</label>
          {toppingGroups.length === 0 ? (
            <p className="text-xs text-gray-400">No topping groups exist yet</p>
          ) : (
            <>
              {assignedGroupIds.length > 0 && (
                <div className="space-y-1 mb-2">
                  {assignedGroupIds.map(gId => {
                    const g = toppingGroups.find(tg => tg.id === gId)
                    if (!g) return null
                    return (
                      <div key={g.id}
                        draggable
                        onDragStart={e => { setDragLinkId(g.id); e.dataTransfer.effectAllowed = 'move' }}
                        onDragEnd={() => { setDragLinkId(null); setDragOverLinkId(null) }}
                        onDragOver={e => { if (dragLinkId && dragLinkId !== g.id) { e.preventDefault(); setDragOverLinkId(g.id) } }}
                        onDragLeave={() => setDragOverLinkId(null)}
                        onDrop={() => { setDragOverLinkId(null); handleLinkDrop(g.id) }}
                        className={`flex items-center gap-2 px-2 py-1.5 bg-white border rounded text-sm cursor-grab active:cursor-grabbing transition-all ${
                          dragLinkId === g.id ? 'opacity-30' : ''
                        } ${dragOverLinkId === g.id && dragLinkId && dragLinkId !== g.id ? 'border-t-2 border-t-[#16A34A]' : 'border-gray-200'}`}
                      >
                        <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/>
                          <circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/>
                          <circle cx="5" cy="13" r="1.5"/><circle cx="11" cy="13" r="1.5"/>
                        </svg>
                        <span className="flex-1">{g.name}</span>
                        <button onClick={() => removeGroup(g.id)}
                          className="text-red-400 hover:text-red-600 text-lg px-1 leading-none"
                          aria-label="Remove">&times;</button>
                      </div>
                    )
                  })}
                </div>
              )}
              {toppingGroups.some(g => !assignedGroupIds.includes(g.id)) && (
                <div className={`space-y-0.5 ${assignedGroupIds.length > 0 ? 'pt-2 border-t border-gray-100' : ''}`}>
                  {assignedGroupIds.length > 0 && (
                    <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold mb-1">Available</p>
                  )}
                  {toppingGroups.filter(g => !assignedGroupIds.includes(g.id)).map(g => (
                    <button key={g.id} onClick={() => addGroup(g.id)}
                      className="block w-full text-left text-sm text-gray-600 hover:bg-gray-50 px-2 py-1 rounded">
                      + {g.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="p-4 border-t">
        <button onClick={handleSave} disabled={saving || !name.trim()}
          className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Item'}
        </button>
      </div>
    </div>
  )
}

// ── Topping Group Editor Panel ──
function ToppingGroupEditor({ group, restaurantId, onClose, onSaved }) {
  const [name, setName] = useState(group?.name || '')
  const [placementType, setPlacementType] = useState(group?.placement_type || 'pizza')
  const [selectionType, setSelectionType] = useState(group?.selection_type || 'unlimited')
  const [required, setRequired] = useState(group?.required || false)
  const [maxSelections, setMaxSelections] = useState(group?.max_selections || '')
  const [toppings, setToppings] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (group) fetchToppings()
    else setToppings([{ name: '', price: '', price_half: '', is_default: false, _key: Math.random().toString(36).slice(2) }])
  }, [group?.id])

  async function fetchToppings() {
    const { data } = await supabase.from('toppings').select('*')
      .eq('topping_group_id', group.id).order('sort_order')
    setToppings((data || []).map(t => ({ ...t, _key: t.id })))
  }

  function addTopping() {
    setToppings(prev => [...prev, { name: '', price: '', price_half: '', is_default: false, _key: Math.random().toString(36).slice(2) }])
  }

  function removeTopping(key) {
    setToppings(prev => prev.filter(t => t._key !== key))
  }

  function updateTopping(key, field, value) {
    setToppings(prev => prev.map(t => t._key === key ? { ...t, [field]: value } : t))
  }

  // Single-select addon groups can have at most one default. When
  // checking a new default, clear is_default on every other topping
  // in the group so the saved data stays consistent with the radio
  // invariant the customer modal enforces. Unchecking just toggles
  // off the one row — leaving zero defaults is valid.
  function setDefaultSelected(key, checked) {
    const isSingleAddon = placementType === 'addon' && selectionType === 'single'
    setToppings(prev => prev.map(t => {
      if (t._key === key) return { ...t, is_default: checked }
      if (checked && isSingleAddon) return { ...t, is_default: false }
      return t
    }))
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)

    let groupId = group?.id

    const isAddon = placementType === 'addon'
    const groupPayload = {
      name,
      placement_type: placementType,
      selection_type: isAddon ? selectionType : 'unlimited',
      required: isAddon && selectionType !== 'unlimited' ? required : false,
      max_selections: isAddon && selectionType === 'limited' && maxSelections ? parseInt(maxSelections) : null,
    }

    if (group) {
      await supabase.from('topping_groups').update(groupPayload).eq('id', group.id)
    } else {
      const { data } = await supabase.from('topping_groups').insert({
        restaurant_id: restaurantId, sort_order: 0, ...groupPayload,
      }).select().single()
      if (data) groupId = data.id
    }

    if (!groupId) { setSaving(false); return }

    // Sync toppings: update existing, insert new, delete removed
    const valid = toppings.filter(t => t.name.trim() && (t.price !== '' && t.price !== undefined))
    const existingToppingIds = valid.filter(t => t.id).map(t => t.id)

    // Delete toppings that were removed (may fail silently if referenced by orders)
    const { data: currentToppings } = await supabase.from('toppings').select('id').eq('topping_group_id', groupId)
    const toppingIdsToDelete = (currentToppings || []).map(t => t.id).filter(id => !existingToppingIds.includes(id))
    for (const id of toppingIdsToDelete) {
      await supabase.from('toppings').delete().eq('id', id)
    }

    // Upsert toppings
    for (let i = 0; i < valid.length; i++) {
      const t = valid[i]
      const priceHalf = (t.price_half === '' || t.price_half == null) ? null : parseFloat(t.price_half)
      if (t.id) {
        await supabase.from('toppings').update({ name: t.name, price: parseFloat(t.price), price_half: priceHalf, sort_order: i, is_default: !!t.is_default }).eq('id', t.id)
      } else {
        await supabase.from('toppings').insert({
          topping_group_id: groupId, restaurant_id: restaurantId,
          name: t.name, price: parseFloat(t.price), price_half: priceHalf, sort_order: i, is_default: !!t.is_default,
        })
      }
    }

    setSaving(false)
    onSaved()
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-bold">{group ? 'Edit Topping Group' : 'New Topping Group'}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-xs text-gray-500">Group Name</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
        </div>

        {/* Placement Type */}
        <div>
          <label className="text-xs text-gray-500 uppercase font-semibold mb-2 block">Type</label>
          <div className="flex gap-2">
            <button onClick={() => setPlacementType('pizza')}
              className={`flex-1 h-9 rounded-lg text-sm font-semibold transition-colors ${
                placementType === 'pizza' ? 'bg-[#16A34A] text-white' : 'border border-gray-300 text-gray-700'
              }`}>Pizza Toppings</button>
            <button onClick={() => setPlacementType('addon')}
              className={`flex-1 h-9 rounded-lg text-sm font-semibold transition-colors ${
                placementType === 'addon' ? 'bg-[#16A34A] text-white' : 'border border-gray-300 text-gray-700'
              }`}>Add-Ons</button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {placementType === 'pizza' ? 'Shows Left / Whole / Right placement, half price for L/R' : 'Simple select/deselect, no placement options'}
          </p>
        </div>

        {/* Addon-specific options */}
        {placementType === 'addon' && (
          <>
            <div>
              <label className="text-xs text-gray-500 uppercase font-semibold mb-2 block">Selection Rule</label>
              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="radio" name="selectionType" checked={selectionType === 'single'}
                    onChange={() => setSelectionType('single')} className="accent-[#16A34A] w-4 h-4" />
                  <span className="text-sm">Pick exactly 1</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="radio" name="selectionType" checked={selectionType === 'limited'}
                    onChange={() => setSelectionType('limited')} className="accent-[#16A34A] w-4 h-4" />
                  <span className="text-sm">Pick up to</span>
                  {selectionType === 'limited' && (
                    <input type="number" min="1" value={maxSelections} onChange={e => setMaxSelections(e.target.value)}
                      className="w-16 h-8 px-2 border border-gray-300 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                      placeholder="N" />
                  )}
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="radio" name="selectionType" checked={selectionType === 'unlimited'}
                    onChange={() => setSelectionType('unlimited')} className="accent-[#16A34A] w-4 h-4" />
                  <span className="text-sm">Unlimited</span>
                </label>
              </div>
            </div>

            {selectionType !== 'unlimited' && (
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)}
                  className="accent-[#16A34A] w-4 h-4" />
                <span className="text-sm">Customer must make a selection before adding to cart</span>
              </label>
            )}
          </>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-500 uppercase font-semibold">{placementType === 'addon' ? 'Add-Ons' : 'Toppings'}</label>
            <button onClick={addTopping} className="text-xs text-[#16A34A] font-semibold">+ Add Topping</button>
          </div>
          {placementType === 'pizza' && (
            <p className="text-xs text-gray-400 mb-2">
              Half price is optional — leave blank to charge whole / 2 for left or right placements.
            </p>
          )}
          {toppings.map(t => (
            <div key={t._key} className="mb-3">
              <div className="flex gap-2">
                <input value={t.name} onChange={e => updateTopping(t._key, 'name', e.target.value)}
                  placeholder="Topping name" className="flex-1 h-9 px-3 border border-gray-300 rounded-lg text-sm" />
                <div className="relative w-20">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="number" step="0.01" value={t.price} onChange={e => updateTopping(t._key, 'price', e.target.value)}
                    placeholder="Whole" title="Whole-pizza price"
                    className="w-full h-9 pl-6 pr-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                {placementType === 'pizza' && (
                  <div className="relative w-20">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input
                      type="number" step="0.01"
                      value={t.price_half ?? ''}
                      onChange={e => updateTopping(t._key, 'price_half', e.target.value)}
                      placeholder="Half"
                      title="Half-pizza price (optional, defaults to whole / 2)"
                      className="w-full h-9 pl-6 pr-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                )}
                <button onClick={() => removeTopping(t._key)} className="text-red-400 hover:text-red-600 text-lg px-1">&times;</button>
              </div>
              <label className="flex items-center gap-2 mt-1 ml-1 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={!!t.is_default}
                  onChange={e => setDefaultSelected(t._key, e.target.checked)}
                  className="accent-[#16A34A] w-3.5 h-3.5"
                />
                <span className="text-xs text-gray-500">Default selected</span>
              </label>
            </div>
          ))}
        </div>
      </div>
      <div className="p-4 border-t">
        <button onClick={handleSave} disabled={saving || !name.trim()}
          className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Topping Group'}
        </button>
      </div>
    </div>
  )
}

// ── Main Menu Management Tab ──
export default function MenuManagementTab() {
  const [restaurants, setRestaurants] = useState([])
  const [selectedRestaurant, setSelectedRestaurant] = useState('')
  const [categories, setCategories] = useState([])
  const [items, setItems] = useState([])
  const [toppingGroups, setToppingGroups] = useState([])
  const [loading, setLoading] = useState(false)

  // Editor state
  const [editingItem, setEditingItem] = useState(null) // { item, categoryId }
  const [editingGroup, setEditingGroup] = useState(undefined) // undefined=closed, null=new, object=editing

  // Category collapse state
  const [expandedCats, setExpandedCats] = useState(new Set())

  function toggleCatExpanded(catId) {
    setExpandedCats(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }

  // Inline add/edit
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [editingCatId, setEditingCatId] = useState(null)
  const [editCatName, setEditCatName] = useState('')

  // Drag reordering state
  const [dragCatId, setDragCatId] = useState(null)
  const [dragOverCatId, setDragOverCatId] = useState(null)
  const [dragItemId, setDragItemId] = useState(null)
  const [dragOverItemId, setDragOverItemId] = useState(null)

  // Menu import modal
  const [showImportModal, setShowImportModal] = useState(false)

  useEffect(() => {
    supabase.from('restaurants').select('id, name, slug').order('name').then(({ data }) => {
      setRestaurants(data || [])
    })
  }, [])

  useEffect(() => {
    if (selectedRestaurant) fetchMenu()
  }, [selectedRestaurant])

  async function fetchMenu() {
    setLoading(true)
    const [catRes, itemRes, groupRes] = await Promise.all([
      supabase.from('menu_categories').select('*').eq('restaurant_id', selectedRestaurant).order('sort_order'),
      supabase.from('menu_items').select('*, item_sizes(*)').eq('restaurant_id', selectedRestaurant).order('sort_order'),
      supabase.from('topping_groups').select('*').eq('restaurant_id', selectedRestaurant).order('sort_order'),
    ])
    setCategories(catRes.data || [])
    setItems(itemRes.data || [])
    setToppingGroups(groupRes.data || [])
    setLoading(false)
  }

  async function addCategory() {
    if (!newCatName.trim()) return
    await supabase.from('menu_categories').insert({
      restaurant_id: selectedRestaurant, name: newCatName, sort_order: categories.length,
    })
    setNewCatName('')
    setAddingCategory(false)
    fetchMenu()
  }

  async function saveCategory(catId) {
    if (!editCatName.trim()) return
    await supabase.from('menu_categories').update({ name: editCatName }).eq('id', catId)
    setEditingCatId(null)
    fetchMenu()
  }

  async function deleteCategory(catId) {
    if (!confirm('Delete this category and all its items?')) return
    await supabase.from('menu_categories').delete().eq('id', catId)
    fetchMenu()
  }

  async function toggleCatDiscountExempt(catId, newValue) {
    await supabase.from('menu_categories').update({ discount_exempt: newValue }).eq('id', catId)
    fetchMenu()
  }

  async function handleCatDrop(targetCatId) {
    if (!dragCatId || dragCatId === targetCatId) return
    const dragIdx = categories.findIndex(c => c.id === dragCatId)
    const targetIdx = categories.findIndex(c => c.id === targetCatId)
    if (dragIdx === -1 || targetIdx === -1) return

    // Reorder locally
    const reordered = [...categories]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(targetIdx, 0, moved)
    setCategories(reordered.map((c, i) => ({ ...c, sort_order: i })))

    // Persist every category's new sort_order to Supabase
    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('menu_categories').update({ sort_order: i }).eq('id', reordered[i].id)
    }
    setDragCatId(null)
  }

  async function handleItemDrop(targetItemId, categoryId) {
    if (!dragItemId || dragItemId === targetItemId) return
    const catItems = items.filter(i => i.category_id === categoryId)
    const dragIdx = catItems.findIndex(i => i.id === dragItemId)
    const targetIdx = catItems.findIndex(i => i.id === targetItemId)
    if (dragIdx === -1 || targetIdx === -1) return

    const reordered = [...catItems]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(targetIdx, 0, moved)

    // Build new sort_order map
    const newOrderMap = new Map(reordered.map((item, i) => [item.id, i]))

    // Optimistic local state update
    setItems(prev => {
      const updated = prev.map(item => {
        const newOrder = newOrderMap.get(item.id)
        return newOrder !== undefined ? { ...item, sort_order: newOrder } : item
      })
      return updated.sort((a, b) => a.sort_order - b.sort_order)
    })

    // Persist every item's new sort_order to Supabase
    const updates = reordered.map((item, i) => ({ id: item.id, sort_order: i }))
    for (const u of updates) {
      await supabase.from('menu_items').update({ sort_order: u.sort_order }).eq('id', u.id)
    }
    setDragItemId(null)
  }

  async function toggleItemAvailability(item) {
    await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', item.id)
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_available: !i.is_available } : i))
  }

  // Move an item up or down within its category. Mobile fallback for the
  // HTML5 drag-and-drop reorder, which is unreliable in iOS Safari.
  async function moveItem(itemId, categoryId, direction) {
    const catItems = items.filter(i => i.category_id === categoryId).sort((a, b) => a.sort_order - b.sort_order)
    const idx = catItems.findIndex(i => i.id === itemId)
    const targetIdx = idx + direction
    if (idx === -1 || targetIdx < 0 || targetIdx >= catItems.length) return
    const reordered = [...catItems]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(targetIdx, 0, moved)
    const newOrderMap = new Map(reordered.map((item, i) => [item.id, i]))
    setItems(prev => {
      const updated = prev.map(item => {
        const newOrder = newOrderMap.get(item.id)
        return newOrder !== undefined ? { ...item, sort_order: newOrder } : item
      })
      return updated.sort((a, b) => a.sort_order - b.sort_order)
    })
    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('menu_items').update({ sort_order: i }).eq('id', reordered[i].id)
    }
  }

  async function deleteItem(itemId) {
    if (!confirm('Delete this item?')) return
    await supabase.from('menu_items').delete().eq('id', itemId)
    fetchMenu()
  }

  async function deleteGroup(groupId) {
    if (!confirm('Delete this topping group?')) return
    await supabase.from('topping_groups').delete().eq('id', groupId)
    fetchMenu()
  }

  function getMinPrice(item) {
    const sizes = item.item_sizes || []
    if (sizes.length === 0) return null
    return formatMoney(Math.min(...sizes.map(s => Number(s.price))))
  }

  const featuredCount = items.filter(i => i.featured_on_website).length
  const showPanel = editingItem || editingGroup !== undefined

  return (
    <div className="h-full flex">
      <div className={`flex-1 overflow-y-auto p-4 md:p-6 ${showPanel ? 'md:max-w-[calc(100%-400px)]' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4">
          <h2 className="text-xl font-bold w-full md:w-auto">Menu Management</h2>
          <select value={selectedRestaurant} onChange={e => { setSelectedRestaurant(e.target.value); setEditingItem(null); setEditingGroup(undefined) }}
            className="h-11 md:h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white flex-1 md:flex-none min-w-0">
            <option value="">Select a restaurant...</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {selectedRestaurant && (
            <button
              onClick={() => setShowImportModal(true)}
              className="px-3 h-11 md:h-9 border border-gray-300 rounded-lg text-sm font-semibold hover:bg-gray-50 shrink-0"
            >
              Import Menu
            </button>
          )}
          {selectedRestaurant && (
            <span className="text-xs text-gray-500 w-full md:w-auto md:ml-auto">Featured: {featuredCount} / {FEATURED_LIMIT}</span>
          )}
        </div>

        {!selectedRestaurant ? (
          <p className="text-gray-400 text-center mt-8">Select a restaurant to manage its menu</p>
        ) : loading ? (
          <p className="text-gray-400 text-center mt-8">Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* Categories + Items */}
            {categories.map(cat => (
              <div
                key={cat.id}
                className={`bg-white rounded-lg border overflow-hidden transition-all ${
                  dragCatId === cat.id ? 'opacity-30 scale-[0.98]' : ''
                } ${dragOverCatId === cat.id && dragCatId && dragCatId !== cat.id ? 'border-[#16A34A] border-2' : 'border-gray-200'}`}
                onDragOver={e => { if (dragCatId) { e.preventDefault(); setDragOverCatId(cat.id) } }}
                onDragLeave={() => setDragOverCatId(null)}
                onDrop={() => { setDragOverCatId(null); handleCatDrop(cat.id) }}
              >
                <div
                  draggable={editingCatId !== cat.id}
                  onDragStart={e => { setDragCatId(cat.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => { setDragCatId(null); setDragOverCatId(null) }}
                  className={`flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200 ${editingCatId !== cat.id ? 'cursor-grab active:cursor-grabbing' : ''}`}
                >
                  {editingCatId === cat.id ? (
                    <div className="flex gap-2 flex-1">
                      <input value={editCatName} onChange={e => setEditCatName(e.target.value)}
                        className="flex-1 h-8 px-3 border border-gray-300 rounded-lg text-sm" autoFocus
                        onKeyDown={e => e.key === 'Enter' && saveCategory(cat.id)} />
                      <button onClick={() => saveCategory(cat.id)} className="text-xs text-[#16A34A] font-semibold">Save</button>
                      <button onClick={() => setEditingCatId(null)} className="text-xs text-gray-400">Cancel</button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5">
                        <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/>
                          <circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/>
                          <circle cx="5" cy="13" r="1.5"/><circle cx="11" cy="13" r="1.5"/>
                        </svg>
                        <button onClick={() => toggleCatExpanded(cat.id)} className="flex items-center gap-2">
                          <svg className={`w-3 h-3 text-gray-400 transition-transform ${expandedCats.has(cat.id) ? 'rotate-90' : ''}`} viewBox="0 0 10 10" fill="currentColor">
                            <path d="M3 1l4 4-4 4z" />
                          </svg>
                          <h3 className="font-semibold text-sm">{cat.name}</h3>
                          {!expandedCats.has(cat.id) && (
                            <span className="text-xs text-gray-400 font-normal">({items.filter(i => i.category_id === cat.id).length})</span>
                          )}
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-xs text-gray-500">
                          <input
                            type="checkbox"
                            checked={cat.discount_exempt === true}
                            onChange={e => toggleCatDiscountExempt(cat.id, e.target.checked)}
                          />
                          Discount Exempt
                        </label>
                        <button onClick={() => { setEditingCatId(cat.id); setEditCatName(cat.name) }}
                          className="text-xs text-gray-500 hover:text-gray-700">Edit</button>
                        <button onClick={() => deleteCategory(cat.id)}
                          className="text-xs text-red-500 hover:text-red-700">Delete</button>
                      </div>
                    </>
                  )}
                </div>
                {expandedCats.has(cat.id) && <div>
                  {items.filter(i => i.category_id === cat.id).map(item => (
                    <div key={item.id}
                      draggable
                      onDragStart={e => { setDragItemId(item.id); e.dataTransfer.effectAllowed = 'move' }}
                      onDragEnd={() => { setDragItemId(null); setDragOverItemId(null) }}
                      onDragOver={e => { if (dragItemId && dragItemId !== item.id) { e.preventDefault(); setDragOverItemId(item.id) } }}
                      onDragLeave={() => setDragOverItemId(null)}
                      onDrop={() => { setDragOverItemId(null); handleItemDrop(item.id, cat.id) }}
                      className={`flex items-center justify-between px-4 py-3 border-b border-gray-100 last:border-0 cursor-grab active:cursor-grabbing transition-all ${
                        !item.is_available ? 'opacity-40' : ''
                      } ${dragItemId === item.id ? 'opacity-30 scale-[0.98]' : ''} ${
                        dragOverItemId === item.id && dragItemId && dragItemId !== item.id ? 'border-t-2 border-t-[#16A34A]' : ''
                      }`}>
                      <svg className="w-4 h-4 text-gray-400 shrink-0 mr-2.5" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/>
                        <circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/>
                        <circle cx="5" cy="13" r="1.5"/><circle cx="11" cy="13" r="1.5"/>
                      </svg>
                      <div className="flex-1 min-w-0 mr-4">
                        <p className="font-medium text-sm">{item.name}</p>
                        {getMinPrice(item) && <p className="text-xs text-gray-500">{getMinPrice(item)}{(item.item_sizes?.length || 0) > 1 ? '+' : ''}</p>}
                      </div>
                      <div className="flex items-center gap-2 md:gap-3 shrink-0">
                        {/* Mobile reorder fallback — HTML5 drag is unreliable on iOS */}
                        <div className="md:hidden flex flex-col">
                          <button onClick={() => moveItem(item.id, cat.id, -1)}
                            className="w-7 h-5 flex items-center justify-center text-gray-500"
                            aria-label="Move up">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 10 10"><path d="M5 2l4 4H1z" /></svg>
                          </button>
                          <button onClick={() => moveItem(item.id, cat.id, 1)}
                            className="w-7 h-5 flex items-center justify-center text-gray-500"
                            aria-label="Move down">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 10 10"><path d="M5 8l4-4H1z" /></svg>
                          </button>
                        </div>
                        <button onClick={() => toggleItemAvailability(item)}
                          className={`relative w-10 h-6 rounded-full transition-colors ${item.is_available ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
                          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${item.is_available ? 'left-4.5' : 'left-0.5'}`} />
                        </button>
                        <button onClick={() => setEditingItem({ item, categoryId: cat.id })}
                          className="text-xs text-[#16A34A] font-semibold min-h-[44px] px-2 md:min-h-0 md:px-0">Edit</button>
                        <button onClick={() => deleteItem(item.id)}
                          className="text-xs text-red-500 min-h-[44px] px-2 md:min-h-0 md:px-0">Delete</button>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={() => { setEditingItem({ item: null, categoryId: cat.id }); setExpandedCats(prev => new Set(prev).add(cat.id)) }}
                    className="w-full py-2.5 text-sm text-[#16A34A] font-semibold hover:bg-green-50 transition-colors">
                    + Add Item
                  </button>
                </div>}
              </div>
            ))}

            {/* Add category */}
            {addingCategory ? (
              <div className="flex gap-2">
                <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
                  placeholder="Category name" autoFocus
                  className="flex-1 h-10 px-3 border border-gray-300 rounded-lg text-sm"
                  onKeyDown={e => e.key === 'Enter' && addCategory()} />
                <button onClick={addCategory} className="px-4 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold">Add</button>
                <button onClick={() => { setAddingCategory(false); setNewCatName('') }}
                  className="px-4 h-10 border border-gray-300 rounded-lg text-sm">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setAddingCategory(true)}
                className="w-full h-10 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 font-semibold hover:border-[#16A34A] hover:text-[#16A34A] transition-colors">
                + Add Category
              </button>
            )}

            {/* Topping Groups */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Topping Groups</h3>
                <button onClick={() => setEditingGroup(null)}
                  className="text-sm text-[#16A34A] font-semibold">+ New Group</button>
              </div>
              {toppingGroups.length === 0 ? (
                <p className="text-gray-400 text-sm">No topping groups yet</p>
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 divide-y">
                  {toppingGroups.map(g => (
                    <div key={g.id} className="flex items-center justify-between px-4 py-3">
                      <span className="font-medium text-sm">{g.name}</span>
                      <div className="flex gap-2">
                        <button onClick={() => setEditingGroup(g)} className="text-xs text-[#16A34A] font-semibold">Edit</button>
                        <button onClick={() => deleteGroup(g.id)} className="text-xs text-red-500">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Side panel */}
      {editingItem && (
        <div className="fixed inset-0 z-40 md:relative md:inset-auto md:z-auto md:w-[400px] md:shrink-0">
          <ItemEditor
            item={editingItem.item}
            categoryId={editingItem.categoryId}
            restaurantId={selectedRestaurant}
            restaurantSlug={restaurants.find(r => r.id === selectedRestaurant)?.slug || selectedRestaurant}
            toppingGroups={toppingGroups}
            featuredCount={featuredCount}
            onClose={() => setEditingItem(null)}
            onSaved={() => {
              const catId = editingItem.categoryId
              const wasNew = !editingItem.item
              fetchMenu()
              if (wasNew) {
                // Keep adding items in the same category
                setEditingItem({ item: null, categoryId: catId })
              } else {
                // Editing existing — close the panel
                setEditingItem(null)
              }
            }}
          />
        </div>
      )}
      {editingGroup !== undefined && !editingItem && (
        <div className="fixed inset-0 z-40 md:relative md:inset-auto md:z-auto md:w-[400px] md:shrink-0">
          <ToppingGroupEditor
            group={editingGroup}
            restaurantId={selectedRestaurant}
            onClose={() => setEditingGroup(undefined)}
            onSaved={() => { setEditingGroup(undefined); fetchMenu() }}
          />
        </div>
      )}

      {showImportModal && selectedRestaurant && (
        <MenuImportModal
          restaurant={restaurants.find(r => r.id === selectedRestaurant)}
          onClose={() => setShowImportModal(false)}
          onImported={fetchMenu}
        />
      )}
    </div>
  )
}
