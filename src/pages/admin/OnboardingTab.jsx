import { useState } from 'react'
import { supabase } from '../../lib/supabase'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const DEFAULT_HOURS = DAY_NAMES.map((_, i) => ({
  day_of_week: i,
  is_open: i >= 1 && i <= 5, // Mon-Fri open by default
  open_time: '11:00',
  close_time: i === 0 || i === 6 ? '23:00' : '22:00',
}))

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// ── Step components ──
function Step1({ data, setData }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Restaurant Info</h3>
      <div>
        <label className="text-sm text-gray-500">Restaurant Name</label>
        <input value={data.name} onChange={e => { setData({ ...data, name: e.target.value, slug: data._slugEdited ? data.slug : slugify(e.target.value) }) }}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
      <div>
        <label className="text-sm text-gray-500">URL Slug</label>
        <div className="flex items-center gap-1">
          <span className="text-sm text-gray-400">directbite.co/</span>
          <input value={data.slug} onChange={e => setData({ ...data, slug: e.target.value, _slugEdited: true })}
            className="flex-1 h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
        </div>
      </div>
      <div>
        <label className="text-sm text-gray-500">Phone</label>
        <input value={data.phone} onChange={e => setData({ ...data, phone: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
      <div>
        <label className="text-sm text-gray-500">Address</label>
        <input value={data.address} onChange={e => setData({ ...data, address: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
    </div>
  )
}

function Step2({ data, setData }) {
  function updateHour(dayIndex, field, value) {
    const newHours = data.hours.map(h => h.day_of_week === dayIndex ? { ...h, [field]: value } : h)
    setData({ ...data, hours: newHours })
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Hours</h3>
      {data.hours.map(h => (
        <div key={h.day_of_week} className="flex items-center gap-3">
          <span className="w-24 text-sm font-medium">{DAY_NAMES[h.day_of_week]}</span>
          <button onClick={() => updateHour(h.day_of_week, 'is_open', !h.is_open)}
            className={`relative w-12 h-7 rounded-full transition-colors ${h.is_open ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${h.is_open ? 'left-5.5' : 'left-0.5'}`} />
          </button>
          {h.is_open ? (
            <div className="flex items-center gap-1 flex-1">
              <input type="time" value={h.open_time} onChange={e => updateHour(h.day_of_week, 'open_time', e.target.value)}
                className="h-9 px-2 border border-gray-300 rounded-lg text-sm flex-1" />
              <span className="text-gray-400 text-xs">to</span>
              <input type="time" value={h.close_time} onChange={e => updateHour(h.day_of_week, 'close_time', e.target.value)}
                className="h-9 px-2 border border-gray-300 rounded-lg text-sm flex-1" />
            </div>
          ) : (
            <span className="text-sm text-gray-400">Closed</span>
          )}
        </div>
      ))}
    </div>
  )
}

function Step3({ data, setData }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Ordering Settings</h3>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Delivery Available</span>
        <button onClick={() => setData({ ...data, delivery_available: !data.delivery_available })}
          className={`relative w-12 h-7 rounded-full transition-colors ${data.delivery_available ? 'bg-[#16A34A]' : 'bg-gray-300'}`}>
          <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${data.delivery_available ? 'left-5.5' : 'left-0.5'}`} />
        </button>
      </div>
      {data.delivery_available && (
        <>
          <div>
            <label className="text-sm text-gray-500">Delivery Fee ($)</label>
            <input type="number" step="0.01" value={data.delivery_fee} onChange={e => setData({ ...data, delivery_fee: e.target.value })}
              className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
          </div>
          <div>
            <label className="text-sm text-gray-500">Delivery Note</label>
            <input value={data.delivery_note} onChange={e => setData({ ...data, delivery_note: e.target.value })}
              className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
          </div>
        </>
      )}
      <div>
        <label className="text-sm text-gray-500">Est. Pickup Minutes</label>
        <input type="number" value={data.estimated_pickup_minutes} onChange={e => setData({ ...data, estimated_pickup_minutes: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
      <div>
        <label className="text-sm text-gray-500">Est. Delivery Minutes</label>
        <input type="number" value={data.estimated_delivery_minutes} onChange={e => setData({ ...data, estimated_delivery_minutes: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
      <div>
        <label className="text-sm text-gray-500">Tax Rate (%)</label>
        <input type="number" step="0.001" value={data.tax_rate_pct} onChange={e => setData({ ...data, tax_rate_pct: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
    </div>
  )
}

function Step4({ data, setData }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Tablet Login</h3>
      <p className="text-sm text-gray-500">This creates a Supabase Auth account for the restaurant's tablet.</p>
      <div>
        <label className="text-sm text-gray-500">Tablet Email</label>
        <input type="email" value={data.tablet_email} onChange={e => setData({ ...data, tablet_email: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
      <div>
        <label className="text-sm text-gray-500">Tablet Password</label>
        <input type="text" value={data.tablet_password} onChange={e => setData({ ...data, tablet_password: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          placeholder="Visible — share with restaurant" />
      </div>
    </div>
  )
}

function Step5({ data, setData }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Stripe & PrintNode</h3>
      <div>
        <label className="text-sm text-gray-500">Stripe Connect Account ID</label>
        <input value={data.stripe_account_id} onChange={e => setData({ ...data, stripe_account_id: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          placeholder="acct_..." />
      </div>
      <div>
        <label className="text-sm text-gray-500">PrintNode Printer ID</label>
        <input value={data.printnode_printer_id} onChange={e => setData({ ...data, printnode_printer_id: e.target.value })}
          className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
      </div>
    </div>
  )
}

function Step6({ data }) {
  const openDays = data.hours.filter(h => h.is_open)

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Confirm & Create</h3>
      <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
        <p><strong>Name:</strong> {data.name}</p>
        <p><strong>URL:</strong> directbite.co/{data.slug}</p>
        <p><strong>Phone:</strong> {data.phone || '—'}</p>
        <p><strong>Address:</strong> {data.address || '—'}</p>
        <hr className="my-2" />
        <p><strong>Open days:</strong> {openDays.map(h => DAY_NAMES[h.day_of_week]).join(', ') || 'None'}</p>
        <hr className="my-2" />
        <p><strong>Delivery:</strong> {data.delivery_available ? `Yes ($${data.delivery_fee || 0} fee)` : 'No'}</p>
        <p><strong>Pickup time:</strong> {data.estimated_pickup_minutes} min</p>
        <p><strong>Delivery time:</strong> {data.estimated_delivery_minutes} min</p>
        <p><strong>Tax rate:</strong> {data.tax_rate_pct}%</p>
        <hr className="my-2" />
        <p><strong>Tablet email:</strong> {data.tablet_email}</p>
        <p><strong>Stripe ID:</strong> {data.stripe_account_id || '—'}</p>
        <p><strong>Printer ID:</strong> {data.printnode_printer_id || '—'}</p>
      </div>
    </div>
  )
}

// ── Main Onboarding Tab ──
export default function OnboardingTab() {
  const [step, setStep] = useState(1)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(null)

  const [data, setData] = useState({
    name: '',
    slug: '',
    _slugEdited: false,
    phone: '',
    address: '',
    hours: DEFAULT_HOURS.map(h => ({ ...h })),
    delivery_available: false,
    delivery_fee: '0',
    delivery_note: '',
    estimated_pickup_minutes: '30',
    estimated_delivery_minutes: '60',
    tax_rate_pct: '6.625',
    tablet_email: '',
    tablet_password: '',
    stripe_account_id: '',
    printnode_printer_id: '',
  })

  const steps = [
    { num: 1, label: 'Info' },
    { num: 2, label: 'Hours' },
    { num: 3, label: 'Ordering' },
    { num: 4, label: 'Tablet' },
    { num: 5, label: 'Integrations' },
    { num: 6, label: 'Confirm' },
  ]

  async function handleCreate() {
    setCreating(true)
    setError('')

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-restaurant`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          name: data.name,
          slug: data.slug,
          phone: data.phone,
          address: data.address,
          hours: data.hours,
          delivery_available: data.delivery_available,
          delivery_fee: parseFloat(data.delivery_fee) || 0,
          delivery_note: data.delivery_note,
          estimated_pickup_minutes: parseInt(data.estimated_pickup_minutes) || 30,
          estimated_delivery_minutes: parseInt(data.estimated_delivery_minutes) || 60,
          tax_rate: (parseFloat(data.tax_rate_pct) || 0) / 100,
          tablet_email: data.tablet_email,
          tablet_password: data.tablet_password,
          stripe_account_id: data.stripe_account_id,
          printnode_printer_id: data.printnode_printer_id,
        }),
      }
    )

    const result = await res.json()

    if (result.success) {
      setSuccess(result.restaurant)
    } else {
      setError(result.error || 'Failed to create restaurant')
    }
    setCreating(false)
  }

  if (success) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-[#16A34A]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold mb-2">Restaurant Created!</h2>
          <p className="text-gray-500 mb-4">{success.name} is now live on DirectBite</p>
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-500">Restaurant URL</p>
            <p className="text-lg font-bold text-[#16A34A]">directbite.co/{success.slug}</p>
          </div>
          <button
            onClick={() => { setSuccess(null); setStep(1); setData({ ...data, name: '', slug: '', _slugEdited: false, phone: '', address: '', tablet_email: '', tablet_password: '', stripe_account_id: '', printnode_printer_id: '' }) }}
            className="px-6 h-10 bg-[#16A34A] text-white font-semibold rounded-lg text-sm"
          >
            Add Another Restaurant
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-xl font-bold mb-6">Onboard New Restaurant</h2>

      <div className="max-w-xl mx-auto">
        {/* Step indicator */}
        <div className="flex items-center justify-between mb-8">
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center">
              <button
                onClick={() => setStep(s.num)}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  step === s.num ? 'bg-[#16A34A] text-white' :
                  step > s.num ? 'bg-green-100 text-[#16A34A]' :
                  'bg-gray-100 text-gray-400'
                }`}
              >
                {step > s.num ? '✓' : s.num}
              </button>
              {i < steps.length - 1 && (
                <div className={`w-8 h-0.5 mx-1 ${step > s.num ? 'bg-[#16A34A]' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        {step === 1 && <Step1 data={data} setData={setData} />}
        {step === 2 && <Step2 data={data} setData={setData} />}
        {step === 3 && <Step3 data={data} setData={setData} />}
        {step === 4 && <Step4 data={data} setData={setData} />}
        {step === 5 && <Step5 data={data} setData={setData} />}
        {step === 6 && <Step6 data={data} />}

        {error && <p className="text-red-600 text-sm text-center mt-4">{error}</p>}

        {/* Navigation */}
        <div className="flex justify-between mt-8">
          <button
            onClick={() => setStep(Math.max(1, step - 1))}
            disabled={step === 1}
            className="px-6 h-10 border border-gray-300 rounded-lg text-sm font-semibold disabled:opacity-30"
          >
            Back
          </button>
          {step < 6 ? (
            <button
              onClick={() => setStep(step + 1)}
              className="px-6 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold hover:bg-[#15803D] transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating || !data.name || !data.slug || !data.tablet_email || !data.tablet_password}
              className="px-6 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Restaurant'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
