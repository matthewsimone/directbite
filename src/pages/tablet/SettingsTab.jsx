import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'
import ZipCodeManager from '../../components/ZipCodeManager'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function Section({ title, children, onSave, saving, saved }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{title}</h3>
      {children}
      {onSave && (
        <button
          onClick={onSave}
          disabled={saving}
          className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}
        </button>
      )}
    </div>
  )
}

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm font-medium text-gray-700 shrink-0">{label}</label>
      <div className="flex-1 max-w-[200px]">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-14 h-8 rounded-full transition-colors shrink-0 ${value ? 'bg-[#16A34A]' : 'bg-gray-300'}`}
      style={{ minWidth: 56 }}
    >
      <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${value ? 'left-7' : 'left-1'}`} />
    </button>
  )
}

export default function SettingsTab({ restaurant, setRestaurant }) {
  const [hours, setHours] = useState([])
  const [loadingHours, setLoadingHours] = useState(true)

  // Section save states
  const [savingHours, setSavingHours] = useState(false)
  const [savedHours, setSavedHours] = useState(false)
  const [savingOrdering, setSavingOrdering] = useState(false)
  const [savedOrdering, setSavedOrdering] = useState(false)
  const [savingDelivery, setSavingDelivery] = useState(false)
  const [savedDelivery, setSavedDelivery] = useState(false)
  const [savingTax, setSavingTax] = useState(false)
  const [savedTax, setSavedTax] = useState(false)
  const [savingPrinter, setSavingPrinter] = useState(false)
  const [savedPrinter, setSavedPrinter] = useState(false)
  const [savingSms, setSavingSms] = useState(false)
  const [savedSms, setSavedSms] = useState(false)

  // Local state for editable fields
  const [pickupMinutes, setPickupMinutes] = useState(restaurant?.estimated_pickup_minutes || 30)
  const [deliveryMinutes, setDeliveryMinutes] = useState(restaurant?.estimated_delivery_minutes || 60)
  const [deliveryAvailable, setDeliveryAvailable] = useState(restaurant?.delivery_available || false)
  const [deliveryFeeType, setDeliveryFeeType] = useState(restaurant?.delivery_fee_type || 'flat')
  const [deliveryFee, setDeliveryFee] = useState(restaurant?.delivery_fee || 0)
  const [deliveryNote, setDeliveryNote] = useState(restaurant?.delivery_note || '')
  const [deliveryMinimum, setDeliveryMinimum] = useState(restaurant?.delivery_minimum || 0)
  const [taxRate, setTaxRate] = useState(restaurant ? (Number(restaurant.tax_rate) * 100).toFixed(3) : '0')
  const [printerIp, setPrinterIp] = useState(restaurant?.printer_ip || '')
  const [smsEnabled, setSmsEnabled] = useState(restaurant?.sms_enabled || false)
  const [smsPhone, setSmsPhone] = useState(restaurant?.sms_phone || '')

  useEffect(() => {
    fetchHours()
  }, [restaurant?.id])

  async function fetchHours() {
    if (!restaurant) return

    const { data } = await supabase
      .from('hours')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('day_of_week')

    if (data && data.length > 0) {
      setHours(data)
    } else {
      // Initialize empty hours for all days
      const defaults = DAY_NAMES.map((_, i) => ({
        day_of_week: i,
        is_open: false,
        open_time: '09:00',
        close_time: '21:00',
        restaurant_id: restaurant.id,
      }))
      setHours(defaults)
    }
    setLoadingHours(false)
  }

  function updateHour(dayIndex, field, value) {
    setHours(prev => prev.map(h =>
      h.day_of_week === dayIndex ? { ...h, [field]: value } : h
    ))
  }

  async function saveHours() {
    setSavingHours(true)
    setSavedHours(false)

    for (const h of hours) {
      if (h.id) {
        await supabase
          .from('hours')
          .update({ is_open: h.is_open, open_time: h.open_time, close_time: h.close_time })
          .eq('id', h.id)
      } else {
        const { data } = await supabase
          .from('hours')
          .insert({
            restaurant_id: restaurant.id,
            day_of_week: h.day_of_week,
            is_open: h.is_open,
            open_time: h.open_time,
            close_time: h.close_time,
          })
          .select()
          .single()

        if (data) {
          setHours(prev => prev.map(hr =>
            hr.day_of_week === h.day_of_week ? data : hr
          ))
        }
      }
    }

    setSavingHours(false)
    setSavedHours(true)
    setTimeout(() => setSavedHours(false), 2000)
  }

  async function saveOrdering() {
    setSavingOrdering(true)
    setSavedOrdering(false)

    const { data } = await supabase
      .from('restaurants')
      .update({
        estimated_pickup_minutes: parseInt(pickupMinutes) || 30,
        estimated_delivery_minutes: parseInt(deliveryMinutes) || 60,
      })
      .eq('id', restaurant.id)
      .select()
      .single()

    if (data) setRestaurant(data)
    setSavingOrdering(false)
    setSavedOrdering(true)
    setTimeout(() => setSavedOrdering(false), 2000)
  }

  async function saveDelivery() {
    setSavingDelivery(true)
    setSavedDelivery(false)

    const { data } = await supabase
      .from('restaurants')
      .update({
        delivery_available: deliveryAvailable,
        delivery_fee_type: deliveryFeeType,
        delivery_fee: deliveryFeeType === 'none' ? 0 : (parseFloat(deliveryFee) || 0),
        delivery_note: deliveryNote,
        delivery_minimum: parseFloat(deliveryMinimum) || 0,
      })
      .eq('id', restaurant.id)
      .select()
      .single()

    if (data) setRestaurant(data)
    setSavingDelivery(false)
    setSavedDelivery(true)
    setTimeout(() => setSavedDelivery(false), 2000)
  }

  async function saveTax() {
    setSavingTax(true)
    setSavedTax(false)

    const { data } = await supabase
      .from('restaurants')
      .update({
        tax_rate: (parseFloat(taxRate) || 0) / 100,
      })
      .eq('id', restaurant.id)
      .select()
      .single()

    if (data) setRestaurant(data)
    setSavingTax(false)
    setSavedTax(true)
    setTimeout(() => setSavedTax(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-lg mx-auto space-y-4">
        {/* Restaurant Info (read only) */}
        <Section title="Restaurant Info">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400">Name</label>
              <p className="font-medium">{restaurant?.name}</p>
            </div>
            <div>
              <label className="text-xs text-gray-400">Phone</label>
              <p className="font-medium">{restaurant?.phone || '—'}</p>
            </div>
            <div>
              <label className="text-xs text-gray-400">Address</label>
              <p className="font-medium">{restaurant?.address || '—'}</p>
            </div>
            <p className="text-xs text-gray-400 italic">Contact DirectBite to update this information</p>
            <div className="mt-3">
              <label className="text-xs text-gray-400 mb-1 block">Hero Image</label>
              <ImageUpload
                currentImageUrl={restaurant?.hero_image_url}
                bucketName="hero-images"
                storagePath={`${restaurant?.slug}/hero.jpg`}
                onUpload={async (url) => {
                  const { data } = await supabase
                    .from('restaurants')
                    .update({ hero_image_url: url })
                    .eq('id', restaurant.id)
                    .select()
                    .single()
                  if (data) setRestaurant(data)
                }}
                placeholder="Upload Hero Image"
              />
            </div>
          </div>
        </Section>

        {/* Hours */}
        <Section title="Hours" onSave={saveHours} saving={savingHours} saved={savedHours}>
          {loadingHours ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : (
            <div className="space-y-3">
              {hours.map(h => (
                <div key={h.day_of_week} className="flex items-center gap-3">
                  <span className="w-24 text-sm font-medium shrink-0">{DAY_NAMES[h.day_of_week]}</span>
                  <Toggle
                    value={h.is_open}
                    onChange={val => updateHour(h.day_of_week, 'is_open', val)}
                  />
                  {h.is_open ? (
                    <div className="flex items-center gap-1 flex-1">
                      <input
                        type="time"
                        value={h.open_time || '09:00'}
                        onChange={e => updateHour(h.day_of_week, 'open_time', e.target.value)}
                        className="h-10 px-2 border border-gray-300 rounded-lg text-sm flex-1"
                      />
                      <span className="text-gray-400 text-xs">to</span>
                      <input
                        type="time"
                        value={h.close_time || '21:00'}
                        onChange={e => updateHour(h.day_of_week, 'close_time', e.target.value)}
                        className="h-10 px-2 border border-gray-300 rounded-lg text-sm flex-1"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">Closed</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Ordering */}
        <Section title="Ordering" onSave={saveOrdering} saving={savingOrdering} saved={savedOrdering}>
          <FieldRow label="Est. Pickup Time">
            <div className="relative">
              <input
                type="number"
                min="1"
                value={pickupMinutes}
                onChange={e => setPickupMinutes(e.target.value)}
                className="w-full h-11 px-3 pr-12 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">min</span>
            </div>
          </FieldRow>
          <FieldRow label="Est. Delivery Time">
            <div className="relative">
              <input
                type="number"
                min="1"
                value={deliveryMinutes}
                onChange={e => setDeliveryMinutes(e.target.value)}
                className="w-full h-11 px-3 pr-12 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">min</span>
            </div>
          </FieldRow>
        </Section>

        {/* Delivery */}
        <Section title="Delivery" onSave={saveDelivery} saving={savingDelivery} saved={savedDelivery}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Delivery Available</span>
            <Toggle value={deliveryAvailable} onChange={setDeliveryAvailable} />
          </div>
          {deliveryAvailable && (
            <>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">Fee Type</label>
                <div className="flex gap-2">
                  {[['flat', 'Flat $'], ['percentage', 'Percentage %'], ['none', 'No Charge']].map(([val, label]) => (
                    <button key={val} onClick={() => setDeliveryFeeType(val)}
                      className={`flex-1 h-11 rounded-xl text-sm font-semibold transition-colors ${
                        deliveryFeeType === val ? 'bg-[#16A34A] text-white' : 'border border-gray-300 text-gray-700'
                      }`}>{label}</button>
                  ))}
                </div>
              </div>
              {deliveryFeeType === 'flat' && (
                <FieldRow label="Delivery Fee">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input type="number" min="0" step="0.01" value={deliveryFee}
                      onChange={e => setDeliveryFee(e.target.value)}
                      className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                  </div>
                </FieldRow>
              )}
              {deliveryFeeType === 'percentage' && (
                <FieldRow label="Delivery Fee">
                  <div className="relative">
                    <input type="number" min="0" step="0.1" value={deliveryFee}
                      onChange={e => setDeliveryFee(e.target.value)}
                      className="w-full h-11 px-3 pr-8 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                  </div>
                </FieldRow>
              )}
              <FieldRow label="Minimum Order">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="number" min="0" step="0.01" value={deliveryMinimum}
                    onChange={e => setDeliveryMinimum(e.target.value)}
                    className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                </div>
              </FieldRow>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Delivery Note</label>
                <input
                  type="text"
                  value={deliveryNote}
                  onChange={e => setDeliveryNote(e.target.value)}
                  className="w-full h-11 px-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                  placeholder="e.g., 5 mile delivery radius"
                />
              </div>
              <ZipCodeManager restaurantId={restaurant?.id} />
            </>
          )}
        </Section>

        {/* Tax Rate */}
        <Section title="Tax Rate" onSave={saveTax} saving={savingTax} saved={savedTax}>
          <FieldRow label="Tax Rate">
            <div className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.001"
                value={taxRate}
                onChange={e => setTaxRate(e.target.value)}
                className="w-full h-11 px-3 pr-8 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
            </div>
          </FieldRow>
        </Section>

        {/* Printer */}
        <Section title="Printer" onSave={async () => {
          setSavingPrinter(true); setSavedPrinter(false)
          const { data } = await supabase.from('restaurants').update({ printer_ip: printerIp.trim() || null }).eq('id', restaurant.id).select().single()
          if (data) setRestaurant(data)
          setSavingPrinter(false); setSavedPrinter(true)
          setTimeout(() => setSavedPrinter(false), 2000)
        }} saving={savingPrinter} saved={savedPrinter}>
          <FieldRow label="Printer IP Address">
            <input
              type="text"
              value={printerIp}
              onChange={e => setPrinterIp(e.target.value)}
              placeholder="192.168.1.100"
              className="w-full h-11 px-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
            />
          </FieldRow>
        </Section>

        {/* SMS Alerts */}
        <Section title="SMS Order Alerts" onSave={async () => {
          setSavingSms(true); setSavedSms(false)
          // Normalize phone to E.164
          const digits = smsPhone.replace(/\D/g, '')
          const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : smsPhone
          const { data } = await supabase.from('restaurants').update({
            sms_enabled: smsEnabled,
            sms_phone: smsEnabled ? normalized : null,
          }).eq('id', restaurant.id).select().single()
          if (data) setRestaurant(data)
          setSavingSms(false); setSavedSms(true)
          setTimeout(() => setSavedSms(false), 2000)
        }} saving={savingSms} saved={savedSms}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Enable SMS Alerts</span>
            <Toggle value={smsEnabled} onChange={setSmsEnabled} />
          </div>
          {smsEnabled && (
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Phone Number</label>
              <input
                type="tel"
                value={smsPhone}
                onChange={e => setSmsPhone(e.target.value)}
                placeholder="(201) 555-1234"
                className="w-full h-11 px-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
              <p className="text-xs text-gray-400 mt-1">US number. You'll receive a text for every new order.</p>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
