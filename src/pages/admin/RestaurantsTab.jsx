import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

function formatMoney(v) { return `$${Number(v).toFixed(2)}` }

function ManagePanel({ restaurant, onClose, onUpdate }) {
  const [data, setData] = useState({ ...restaurant })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState('')

  async function handlePause() {
    const { data: updated } = await supabase
      .from('restaurants').update({ is_open: false }).eq('id', restaurant.id).select().single()
    if (updated) { setData(updated); onUpdate(updated) }
  }

  async function handleResume() {
    const { data: updated } = await supabase
      .from('restaurants').update({ is_open: true }).eq('id', restaurant.id).select().single()
    if (updated) { setData(updated); onUpdate(updated) }
  }

  async function handleReprintLast() {
    setMessage('')
    const { data: lastOrder } = await supabase
      .from('orders').select('id, order_number').eq('restaurant_id', restaurant.id)
      .order('created_at', { ascending: false }).limit(1).single()

    if (!lastOrder) { setMessage('No orders found'); return }

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/retry-print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ order_id: lastOrder.id }),
    })
    const result = await res.json()
    setMessage(result.success ? `Reprinted order #${lastOrder.order_number}` : `Print failed: ${result.message || result.error}`)
  }

  async function handleSave() {
    setSaving(true); setSaved(false)
    const { data: updated } = await supabase
      .from('restaurants')
      .update({
        tax_rate: parseFloat(data.tax_rate) || 0,
        delivery_fee: parseFloat(data.delivery_fee) || 0,
        estimated_pickup_minutes: parseInt(data.estimated_pickup_minutes) || 30,
        estimated_delivery_minutes: parseInt(data.estimated_delivery_minutes) || 60,
        stripe_account_id: data.stripe_account_id || null,
        printnode_printer_id: data.printnode_printer_id || null,
        tablet_email: data.tablet_email || null,
      })
      .eq('id', restaurant.id).select().single()

    if (updated) { setData(updated); onUpdate(updated) }
    setSaving(false); setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function field(label, key, type = 'text') {
    return (
      <div>
        <label className="text-xs text-gray-500">{label}</label>
        <input
          type={type} value={data[key] || ''}
          onChange={e => setData(prev => ({ ...prev, [key]: e.target.value }))}
          className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
        />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-bold text-lg">{data.name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <div>
          <p className="text-sm text-gray-500">URL</p>
          <p className="font-medium text-sm">directbite.co/{data.slug}</p>
        </div>

        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${data.is_open ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm font-medium">{data.is_open ? 'Open' : 'Closed'}</span>
        </div>

        <div className="flex gap-2">
          <button onClick={handlePause} className="flex-1 h-9 rounded-lg border border-red-300 text-red-600 text-sm font-semibold hover:bg-red-50">
            Pause Ordering
          </button>
          <button onClick={handleResume} className="flex-1 h-9 rounded-lg border border-green-300 text-green-600 text-sm font-semibold hover:bg-green-50">
            Resume Ordering
          </button>
        </div>

        <button onClick={handleReprintLast} className="w-full h-9 rounded-lg border border-gray-300 text-sm font-semibold hover:bg-gray-50">
          Reprint Last Order
        </button>

        {message && <p className="text-sm text-center text-[#16A34A] bg-green-50 rounded p-2">{message}</p>}

        <hr />

        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Settings</h4>
          {field('Tax Rate', 'tax_rate', 'number')}
          {field('Delivery Fee ($)', 'delivery_fee', 'number')}
          {field('Est. Pickup Minutes', 'estimated_pickup_minutes', 'number')}
          {field('Est. Delivery Minutes', 'estimated_delivery_minutes', 'number')}
          {field('Stripe Account ID', 'stripe_account_id')}
          {field('PrintNode Printer ID', 'printnode_printer_id')}
          {field('Tablet Email', 'tablet_email', 'email')}
        </div>
      </div>

      <div className="p-4 border-t">
        <button onClick={handleSave} disabled={saving}
          className="w-full h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-[#15803D] transition-colors">
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

export default function RestaurantsTab() {
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  useEffect(() => { fetchRestaurants() }, [])

  async function fetchRestaurants() {
    const { data } = await supabase.from('restaurants').select('*').order('name')
    setRestaurants(data || [])
    setLoading(false)
  }

  function handleUpdate(updated) {
    setRestaurants(prev => prev.map(r => r.id === updated.id ? updated : r))
    setSelected(updated)
  }

  return (
    <div className="h-full flex">
      <div className={`flex-1 overflow-y-auto p-6 ${selected ? 'max-w-[calc(100%-420px)]' : ''}`}>
        <h2 className="text-xl font-bold mb-4">Restaurants</h2>

        {loading ? (
          <p className="text-gray-400 text-center mt-8">Loading...</p>
        ) : restaurants.length === 0 ? (
          <p className="text-gray-400 text-center mt-8">No restaurants yet</p>
        ) : (
          <div className="space-y-3">
            {restaurants.map(r => (
              <div key={r.id}
                className={`bg-white rounded-lg border p-4 flex items-center justify-between cursor-pointer hover:border-[#16A34A] transition-colors ${
                  selected?.id === r.id ? 'border-[#16A34A] ring-1 ring-[#16A34A]' : 'border-gray-200'
                }`}
                onClick={() => setSelected(r)}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-3 h-3 rounded-full shrink-0 ${r.is_open ? 'bg-green-500' : 'bg-red-500'}`} />
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-sm text-gray-500">directbite.co/{r.slug}</p>
                  </div>
                </div>
                <button className="px-3 py-1.5 text-sm font-semibold text-[#16A34A] border border-[#16A34A] rounded-lg hover:bg-green-50">
                  Manage
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="w-[420px] shrink-0">
          <ManagePanel restaurant={selected} onClose={() => setSelected(null)} onUpdate={handleUpdate} />
        </div>
      )}
    </div>
  )
}
