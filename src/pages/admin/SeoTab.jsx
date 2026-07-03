import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { parseAddress } from '../website/utils/address'

// Per-restaurant SEO overrides. Every field is OPTIONAL — blank means the
// prerender's auto-formula (see src/pages/website/utils/seoHead.js) generates
// the value. Saving a blank field writes NULL so the auto-formula kicks back in.
export default function SeoTab() {
  const [restaurants, setRestaurants] = useState([])
  const [selectedRestaurant, setSelectedRestaurant] = useState('')
  const [cuisine, setCuisine] = useState('')
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // Load every restaurant with all SEO fields up front — no per-select refetch.
  useEffect(() => {
    supabase
      .from('restaurants')
      .select('id, name, slug, address, cuisine, seo_title, seo_description')
      .order('name')
      .then(({ data }) => setRestaurants(data || []))
  }, [])

  // Reset the edit fields to the selected row's values (null → empty string).
  useEffect(() => {
    const r = restaurants.find(x => x.id === selectedRestaurant)
    setCuisine(r?.cuisine || '')
    setSeoTitle(r?.seo_title || '')
    setSeoDescription(r?.seo_description || '')
  }, [selectedRestaurant, restaurants])

  const selected = restaurants.find(r => r.id === selectedRestaurant)
  const name = selected?.name || 'Restaurant'
  const effCuisine = cuisine.trim() || 'Pizza'
  // Resolve town/state from the selected restaurant's address so the placeholder
  // shows the REAL auto-formula (e.g. "Best Pizza in Old Tappan, NJ"). Falls back
  // to literal {town}/{state} tokens when the address can't be parsed — mirrors
  // seoHead.js's own `city && state` guard.
  const { city, state } = parseAddress(selected?.address)
  const town = city || '{town}'
  const st = state || '{state}'
  const titlePlaceholder = `${name} | Best ${effCuisine} in ${town}, ${st}`
  const descPlaceholder = `${name}: the best ${effCuisine} in ${town}, ${st}. View our menu, hours, and location. Order directly online for pickup or delivery.`

  async function handleSave() {
    if (!selectedRestaurant) return
    setSaving(true)
    // Empty string → null so clearing an override restores the auto-formula.
    const payload = {
      cuisine: cuisine.trim() || null,
      seo_title: seoTitle.trim() || null,
      seo_description: seoDescription.trim() || null,
    }
    const { data, error } = await supabase
      .from('restaurants')
      .update(payload)
      .eq('id', selectedRestaurant)
      .select()
      .single()
    setSaving(false)
    if (error) {
      toast.error(`SEO save failed: ${error.message}`)
      return
    }
    toast.success('SEO saved')
    // Reflect saved values back into the list so the picker/edit state stay in sync.
    setRestaurants(prev => prev.map(r => (r.id === data.id ? { ...r, ...data } : r)))
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4">
          <h2 className="text-xl font-bold w-full md:w-auto">SEO</h2>
          <select
            value={selectedRestaurant}
            onChange={e => setSelectedRestaurant(e.target.value)}
            className="h-11 md:h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white flex-1 md:flex-none min-w-0"
          >
            <option value="">Select a restaurant...</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {!selectedRestaurant ? (
          <p className="text-gray-400 text-center mt-8">Select a restaurant to edit its SEO</p>
        ) : (
          <div className="max-w-xl space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Homepage SEO</h3>
              <p className="text-xs text-gray-400 mb-4">
                Leave a field blank to use the auto-generated value. Filling one overrides it.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-gray-500">Cuisine</label>
                  <input
                    value={cuisine}
                    onChange={e => setCuisine(e.target.value)}
                    placeholder="Pizza"
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">SEO Title</label>
                  <input
                    value={seoTitle}
                    onChange={e => setSeoTitle(e.target.value)}
                    placeholder={titlePlaceholder}
                    className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">SEO Description</label>
                  <textarea
                    value={seoDescription}
                    onChange={e => setSeoDescription(e.target.value)}
                    rows={3}
                    placeholder={descPlaceholder}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  />
                </div>
              </div>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full md:w-auto px-6 h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D] transition-colors"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
