import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function ZipCodeManager({ restaurantId }) {
  const [zips, setZips] = useState([])
  const [newZip, setNewZip] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!restaurantId) return
    fetchZips()
  }, [restaurantId])

  async function fetchZips() {
    const { data } = await supabase
      .from('delivery_zip_codes')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('zip_code')
    setZips(data || [])
    setLoading(false)
  }

  async function addZip() {
    const zip = newZip.trim()
    if (!zip || zip.length < 5) return
    if (zips.some(z => z.zip_code === zip)) {
      setNewZip('')
      return
    }

    const { data, error } = await supabase
      .from('delivery_zip_codes')
      .insert({ restaurant_id: restaurantId, zip_code: zip })
      .select()
      .single()

    if (!error && data) {
      setZips(prev => [...prev, data].sort((a, b) => a.zip_code.localeCompare(b.zip_code)))
    }
    setNewZip('')
  }

  async function removeZip(id) {
    await supabase.from('delivery_zip_codes').delete().eq('id', id)
    setZips(prev => prev.filter(z => z.id !== id))
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addZip()
    }
  }

  if (loading) return <p className="text-sm text-gray-400">Loading...</p>

  return (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-2 block">Accepted Delivery Zip Codes</label>

      {/* Zip chips */}
      {zips.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {zips.map(z => (
            <span key={z.id} className="inline-flex items-center gap-1 bg-gray-100 text-sm font-medium text-gray-700 px-3 py-1.5 rounded-lg">
              {z.zip_code}
              <button
                onClick={() => removeZip(z.id)}
                className="text-gray-400 hover:text-red-500 ml-0.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {zips.length === 0 && (
        <p className="text-xs text-gray-400 mb-2">No zip codes — delivers anywhere</p>
      )}

      {/* Add input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newZip}
          onChange={e => setNewZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onKeyDown={handleKeyDown}
          placeholder="Enter zip code"
          className="flex-1 h-10 px-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
        />
        <button
          onClick={addZip}
          disabled={newZip.trim().length < 5}
          className="px-4 h-10 bg-[#16A34A] text-white text-sm font-semibold rounded-lg disabled:opacity-40 hover:bg-[#15803D] transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}
