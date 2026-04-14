import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'

function formatMoney(v) { return `$${Number(v).toFixed(2)}` }

// ── Item Editor Panel ──
function ItemEditor({ item, categoryId, restaurantId, restaurantSlug, toppingGroups, onClose, onSaved }) {
  const [name, setName] = useState(item?.name || '')
  const [description, setDescription] = useState(item?.description || '')
  const [imageUrl, setImageUrl] = useState(item?.image_url || '')
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [sizes, setSizes] = useState([])
  const [assignedGroupIds, setAssignedGroupIds] = useState([])
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
      supabase.from('item_topping_groups').select('topping_group_id').eq('item_id', item.id),
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

  function toggleGroup(groupId) {
    setAssignedGroupIds(prev =>
      prev.includes(groupId) ? prev.filter(id => id !== groupId) : [...prev, groupId]
    )
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)

    let itemId = item?.id

    if (item) {
      await supabase.from('menu_items').update({
        name, description, image_url: imageUrl || null, is_available: isAvailable,
      }).eq('id', item.id)
    } else {
      const { data } = await supabase.from('menu_items').insert({
        restaurant_id: restaurantId, category_id: categoryId,
        name, description, image_url: imageUrl || null, is_available: isAvailable, sort_order: 0,
      }).select().single()
      if (data) itemId = data.id
    }

    if (!itemId) { setSaving(false); return }

    // Sync sizes: delete existing, re-insert
    await supabase.from('item_sizes').delete().eq('item_id', itemId)
    const validSizes = sizes.filter(s => s.name.trim() && s.price)
    if (validSizes.length > 0) {
      await supabase.from('item_sizes').insert(
        validSizes.map((s, i) => ({
          item_id: itemId, name: s.name, price: parseFloat(s.price), sort_order: i,
        }))
      )
    }

    // Sync topping group assignments
    await supabase.from('item_topping_groups').delete().eq('item_id', itemId)
    if (assignedGroupIds.length > 0) {
      await supabase.from('item_topping_groups').insert(
        assignedGroupIds.map(gId => ({ item_id: itemId, topping_group_id: gId }))
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

        {/* Sizes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-500 uppercase font-semibold">Sizes</label>
            <button onClick={addSize} className="text-xs text-[#16A34A] font-semibold">+ Add Size</button>
          </div>
          {sizes.map(s => (
            <div key={s._key} className="flex gap-2 mb-2">
              <input value={s.name} onChange={e => updateSize(s._key, 'name', e.target.value)}
                placeholder="Size name" className="flex-1 h-9 px-3 border border-gray-300 rounded-lg text-sm" />
              <div className="relative w-24">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" step="0.01" value={s.price} onChange={e => updateSize(s._key, 'price', e.target.value)}
                  placeholder="0.00" className="w-full h-9 pl-6 pr-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <button onClick={() => removeSize(s._key)} className="text-red-400 hover:text-red-600 text-lg px-1">&times;</button>
            </div>
          ))}
        </div>

        {/* Topping groups */}
        <div>
          <label className="text-xs text-gray-500 uppercase font-semibold mb-2 block">Topping Groups</label>
          {toppingGroups.length === 0 ? (
            <p className="text-xs text-gray-400">No topping groups exist yet</p>
          ) : (
            <div className="space-y-1">
              {toppingGroups.map(g => (
                <label key={g.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={assignedGroupIds.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                    className="accent-[#16A34A] w-4 h-4" />
                  {g.name}
                </label>
              ))}
            </div>
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
    else setToppings([{ name: '', price: '', _key: Math.random().toString(36).slice(2) }])
  }, [group?.id])

  async function fetchToppings() {
    const { data } = await supabase.from('toppings').select('*')
      .eq('topping_group_id', group.id).order('sort_order')
    setToppings((data || []).map(t => ({ ...t, _key: t.id })))
  }

  function addTopping() {
    setToppings(prev => [...prev, { name: '', price: '', _key: Math.random().toString(36).slice(2) }])
  }

  function removeTopping(key) {
    setToppings(prev => prev.filter(t => t._key !== key))
  }

  function updateTopping(key, field, value) {
    setToppings(prev => prev.map(t => t._key === key ? { ...t, [field]: value } : t))
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

    // Sync toppings: delete existing, re-insert
    await supabase.from('toppings').delete().eq('topping_group_id', groupId)
    const valid = toppings.filter(t => t.name.trim() && t.price)
    if (valid.length > 0) {
      await supabase.from('toppings').insert(
        valid.map((t, i) => ({
          topping_group_id: groupId, restaurant_id: restaurantId,
          name: t.name, price: parseFloat(t.price), sort_order: i,
        }))
      )
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
          {toppings.map(t => (
            <div key={t._key} className="flex gap-2 mb-2">
              <input value={t.name} onChange={e => updateTopping(t._key, 'name', e.target.value)}
                placeholder="Topping name" className="flex-1 h-9 px-3 border border-gray-300 rounded-lg text-sm" />
              <div className="relative w-24">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" step="0.01" value={t.price} onChange={e => updateTopping(t._key, 'price', e.target.value)}
                  placeholder="0.00" className="w-full h-9 pl-6 pr-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <button onClick={() => removeTopping(t._key)} className="text-red-400 hover:text-red-600 text-lg px-1">&times;</button>
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

  // Inline add/edit
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [editingCatId, setEditingCatId] = useState(null)
  const [editCatName, setEditCatName] = useState('')

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

  async function toggleItemAvailability(item) {
    await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', item.id)
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_available: !i.is_available } : i))
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

  const showPanel = editingItem || editingGroup !== undefined

  return (
    <div className="h-full flex">
      <div className={`flex-1 overflow-y-auto p-6 ${showPanel ? 'max-w-[calc(100%-400px)]' : ''}`}>
        <div className="flex items-center gap-4 mb-4">
          <h2 className="text-xl font-bold">Menu Management</h2>
          <select value={selectedRestaurant} onChange={e => { setSelectedRestaurant(e.target.value); setEditingItem(null); setEditingGroup(undefined) }}
            className="h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white">
            <option value="">Select a restaurant...</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {!selectedRestaurant ? (
          <p className="text-gray-400 text-center mt-8">Select a restaurant to manage its menu</p>
        ) : loading ? (
          <p className="text-gray-400 text-center mt-8">Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* Categories + Items */}
            {categories.map(cat => (
              <div key={cat.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
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
                      <h3 className="font-semibold text-sm">{cat.name}</h3>
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingCatId(cat.id); setEditCatName(cat.name) }}
                          className="text-xs text-gray-500 hover:text-gray-700">Edit</button>
                        <button onClick={() => deleteCategory(cat.id)}
                          className="text-xs text-red-500 hover:text-red-700">Delete</button>
                      </div>
                    </>
                  )}
                </div>
                <div>
                  {items.filter(i => i.category_id === cat.id).map(item => (
                    <div key={item.id}
                      className={`flex items-center justify-between px-4 py-3 border-b border-gray-100 last:border-0 ${!item.is_available ? 'opacity-40' : ''}`}>
                      <div className="flex-1 min-w-0 mr-4">
                        <p className="font-medium text-sm">{item.name}</p>
                        {getMinPrice(item) && <p className="text-xs text-gray-500">{getMinPrice(item)}{(item.item_sizes?.length || 0) > 1 ? '+' : ''}</p>}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <button onClick={() => toggleItemAvailability(item)}
                          className={`relative w-10 h-6 rounded-full transition-colors ${item.is_available ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
                          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${item.is_available ? 'left-4.5' : 'left-0.5'}`} />
                        </button>
                        <button onClick={() => setEditingItem({ item, categoryId: cat.id })}
                          className="text-xs text-[#16A34A] font-semibold">Edit</button>
                        <button onClick={() => deleteItem(item.id)}
                          className="text-xs text-red-500">Delete</button>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={() => setEditingItem({ item: null, categoryId: cat.id })}
                    className="w-full py-2.5 text-sm text-[#16A34A] font-semibold hover:bg-green-50 transition-colors">
                    + Add Item
                  </button>
                </div>
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
        <div className="w-[400px] shrink-0">
          <ItemEditor
            item={editingItem.item}
            categoryId={editingItem.categoryId}
            restaurantId={selectedRestaurant}
            restaurantSlug={restaurants.find(r => r.id === selectedRestaurant)?.slug || selectedRestaurant}
            toppingGroups={toppingGroups}
            onClose={() => setEditingItem(null)}
            onSaved={() => { setEditingItem(null); fetchMenu() }}
          />
        </div>
      )}
      {editingGroup !== undefined && !editingItem && (
        <div className="w-[400px] shrink-0">
          <ToppingGroupEditor
            group={editingGroup}
            restaurantId={selectedRestaurant}
            onClose={() => setEditingGroup(undefined)}
            onSaved={() => { setEditingGroup(undefined); fetchMenu() }}
          />
        </div>
      )}
    </div>
  )
}
