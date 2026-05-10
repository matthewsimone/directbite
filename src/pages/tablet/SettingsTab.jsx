import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'
import WebsiteSettingsPanel from '../../components/WebsiteSettingsPanel'
// ZipCodeManager removed — replaced by radius-based delivery

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
  const [savingNotifyEmail, setSavingNotifyEmail] = useState(false)
  const [savedNotifyEmail, setSavedNotifyEmail] = useState(false)

  // Local state for editable fields
  const [pickupMinutes, setPickupMinutes] = useState(restaurant?.estimated_pickup_minutes || 30)
  const [deliveryMinutes, setDeliveryMinutes] = useState(restaurant?.estimated_delivery_minutes || 60)
  const [deliveryAvailable, setDeliveryAvailable] = useState(restaurant?.delivery_available || false)
  const [deliveryNote, setDeliveryNote] = useState(restaurant?.delivery_note || '')
  const [deliveryMinimum, setDeliveryMinimum] = useState(restaurant?.delivery_minimum || 0)
  const [tier2Enabled, setTier2Enabled] = useState(!!restaurant?.delivery_tier2_fee_cents)
  // Single tier: singleMaxDist is the outer boundary, singleFee is the fee
  // Two tier: stdZoneDist is tier1 boundary, stdZoneFee is tier1 fee, extZoneDist is outer boundary, extZoneFee is tier2 fee
  const [singleMaxDist, setSingleMaxDist] = useState(restaurant?.delivery_max_radius_miles || '')
  const [singleFee, setSingleFee] = useState(restaurant?.delivery_tier1_fee_cents != null ? (restaurant.delivery_tier1_fee_cents / 100).toFixed(2) : '')
  const [stdZoneDist, setStdZoneDist] = useState(restaurant?.delivery_tier1_max_miles || '')
  const [stdZoneFee, setStdZoneFee] = useState(restaurant?.delivery_tier1_fee_cents != null ? (restaurant.delivery_tier1_fee_cents / 100).toFixed(2) : '')
  const [extZoneDist, setExtZoneDist] = useState(restaurant?.delivery_max_radius_miles || '')
  const [extZoneFee, setExtZoneFee] = useState(restaurant?.delivery_tier2_fee_cents != null ? (restaurant.delivery_tier2_fee_cents / 100).toFixed(2) : '')
  const [taxRate, setTaxRate] = useState(restaurant ? (Number(restaurant.tax_rate) * 100).toFixed(3) : '0')
  const [printerIp, setPrinterIp] = useState(restaurant?.printer_ip || '')
  const [smsEnabled, setSmsEnabled] = useState(restaurant?.sms_enabled || false)
  const [smsPhone, setSmsPhone] = useState(restaurant?.sms_phone || '')
  const [notificationEmail, setNotificationEmail] = useState(restaurant?.notification_email || '')

  const [bulkUpdating, setBulkUpdating] = useState(false)

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

    const updateData = {
      delivery_available: deliveryAvailable,
      delivery_note: deliveryNote,
      delivery_minimum: parseFloat(deliveryMinimum) || 0,
    }
    if (tier2Enabled) {
      updateData.delivery_max_radius_miles = parseFloat(extZoneDist) || null
      updateData.delivery_tier1_max_miles = parseFloat(stdZoneDist) || null
      updateData.delivery_tier1_fee_cents = stdZoneFee ? Math.round(parseFloat(stdZoneFee) * 100) : null
      updateData.delivery_tier2_fee_cents = extZoneFee ? Math.round(parseFloat(extZoneFee) * 100) : null
    } else {
      updateData.delivery_max_radius_miles = parseFloat(singleMaxDist) || null
      updateData.delivery_tier1_fee_cents = singleFee ? Math.round(parseFloat(singleFee) * 100) : null
      updateData.delivery_tier1_max_miles = null
      updateData.delivery_tier2_fee_cents = null
    }
    const { data } = await supabase
      .from('restaurants')
      .update(updateData)
      .eq('id', restaurant.id)
      .select()
      .single()

    if (data) setRestaurant(data)
    setSavingDelivery(false)
    setSavedDelivery(true)
    setTimeout(() => setSavedDelivery(false), 2000)
  }

  // End-of-shift bulk action: flip all in-progress orders for this
  // restaurant to 'complete' (the DB enum value — not 'completed') in
  // a single update. Pure status mutation — no reprint, no SMS, no
  // webhook. RLS already restricts to this tablet's restaurant_id.
  async function handleBulkComplete() {
    if (!restaurant || bulkUpdating) return
    setBulkUpdating(true)
    try {
      const { count, error: countErr } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurant.id)
        .eq('status', 'in_progress')
      if (countErr) {
        console.error('[BulkComplete] count failed', countErr)
        toast.error(`Couldn't load count: ${countErr.message}`)
        return
      }
      const n = count || 0
      if (n === 0) {
        toast('No in-progress orders to complete.')
        return
      }
      if (!confirm(`Mark all ${n} in-progress order${n === 1 ? '' : 's'} as completed? This cannot be undone.`)) return

      const { error: updErr } = await supabase
        .from('orders')
        .update({ status: 'complete' })
        .eq('restaurant_id', restaurant.id)
        .eq('status', 'in_progress')
      if (updErr) {
        console.error('[BulkComplete] update failed', updErr)
        toast.error(`Failed to mark complete: ${updErr.message}`)
        return
      }
      toast.success(`Marked ${n} order${n === 1 ? '' : 's'} as completed`)
    } catch (err) {
      console.error('[BulkComplete] exception', err)
      toast.error(`Unexpected error: ${err?.message || err}`)
    } finally {
      setBulkUpdating(false)
    }
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
        {/* End of shift — bulk-complete in-progress orders */}
        <Section title="End of Shift">
          <p className="text-sm text-gray-600">
            Bulk-mark every order currently In Progress as Completed. Use at the end of a shift to clear out anything that didn't get marked done individually.
          </p>
          <button
            onClick={handleBulkComplete}
            disabled={bulkUpdating}
            className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors"
          >
            {bulkUpdating ? 'Updating...' : 'Mark all in-progress as completed'}
          </button>
        </Section>

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
                <div key={h.day_of_week} className="flex items-center gap-2">
                  <span className="w-16 text-xs font-medium shrink-0">{DAY_NAMES[h.day_of_week].slice(0, 3)}</span>
                  <Toggle
                    value={h.is_open}
                    onChange={val => updateHour(h.day_of_week, 'is_open', val)}
                  />
                  {h.is_open ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <input
                        type="time"
                        value={h.open_time || '09:00'}
                        onChange={e => updateHour(h.day_of_week, 'open_time', e.target.value)}
                        className="h-10 px-1 border border-gray-300 rounded-lg text-xs flex-1 min-w-0"
                      />
                      <span className="text-gray-400 text-xs shrink-0">to</span>
                      <input
                        type="time"
                        value={h.close_time || '21:00'}
                        onChange={e => updateHour(h.day_of_week, 'close_time', e.target.value)}
                        className="h-10 px-1 border border-gray-300 rounded-lg text-xs flex-1 min-w-0"
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
            <span className="text-sm font-medium text-gray-700">Enable Delivery</span>
            <Toggle value={deliveryAvailable} onChange={setDeliveryAvailable} />
          </div>
          {deliveryAvailable && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Add Extended Zone</span>
                <Toggle value={tier2Enabled} onChange={setTier2Enabled} />
              </div>

              {!tier2Enabled ? (
                <>
                  <FieldRow label="Maximum Delivery Distance">
                    <div className="relative">
                      <input type="number" min="0.5" step="0.5" value={singleMaxDist}
                        onChange={e => setSingleMaxDist(e.target.value)}
                        placeholder="e.g., 5"
                        className="w-full h-11 px-3 pr-14 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">miles</span>
                    </div>
                  </FieldRow>
                  <FieldRow label="Delivery Fee">
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input type="number" min="0" step="0.01" value={singleFee}
                        onChange={e => setSingleFee(e.target.value)}
                        placeholder="0.00"
                        className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                    </div>
                  </FieldRow>
                  {singleMaxDist && (
                    <p className="text-xs text-gray-400">Customers beyond {singleMaxDist} miles cannot place delivery orders.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Standard Zone</p>
                    <FieldRow label={`Distance: 0 to`}>
                      <div className="relative">
                        <input type="number" min="0.5" step="0.5" value={stdZoneDist}
                          onChange={e => setStdZoneDist(e.target.value)}
                          placeholder="e.g., 3"
                          className="w-full h-11 px-3 pr-14 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">miles</span>
                      </div>
                    </FieldRow>
                    <FieldRow label="Fee">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input type="number" min="0" step="0.01" value={stdZoneFee}
                          onChange={e => setStdZoneFee(e.target.value)}
                          placeholder="0.00"
                          className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                      </div>
                    </FieldRow>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Extended Zone</p>
                    <FieldRow label={`Distance: ${stdZoneDist || '?'} to`}>
                      <div className="relative">
                        <input type="number" min="0.5" step="0.5" value={extZoneDist}
                          onChange={e => setExtZoneDist(e.target.value)}
                          placeholder="e.g., 5"
                          className="w-full h-11 px-3 pr-14 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">miles</span>
                      </div>
                    </FieldRow>
                    <FieldRow label="Fee">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input type="number" min="0" step="0.01" value={extZoneFee}
                          onChange={e => setExtZoneFee(e.target.value)}
                          placeholder="0.00"
                          className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]" />
                      </div>
                    </FieldRow>
                  </div>
                  {stdZoneDist && extZoneDist && parseFloat(extZoneDist) <= parseFloat(stdZoneDist) && (
                    <p className="text-xs text-red-500">Extended zone distance must be greater than standard zone ({stdZoneDist} mi).</p>
                  )}
                  {stdZoneDist && extZoneDist && stdZoneFee && extZoneFee && parseFloat(extZoneDist) > parseFloat(stdZoneDist) && (
                    <p className="text-xs text-gray-400">
                      Within {stdZoneDist} mi: ${parseFloat(stdZoneFee).toFixed(2)} fee.
                      {' '}{stdZoneDist}–{extZoneDist} mi: ${parseFloat(extZoneFee).toFixed(2)} fee.
                      {' '}Beyond {extZoneDist} mi: no delivery.
                    </p>
                  )}
                </>
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
                  placeholder="e.g., Free delivery on orders over $30"
                />
              </div>
              <p className="text-xs text-gray-400">Distance is measured as straight-line from restaurant.</p>
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

        {/* Notification Email */}
        <Section title="Order Notification Email" onSave={async () => {
          setSavingNotifyEmail(true); setSavedNotifyEmail(false)
          const trimmed = notificationEmail.trim()
          const { data } = await supabase.from('restaurants').update({
            notification_email: trimmed || null,
          }).eq('id', restaurant.id).select().single()
          if (data) setRestaurant(data)
          setSavingNotifyEmail(false); setSavedNotifyEmail(true)
          setTimeout(() => setSavedNotifyEmail(false), 2000)
        }} saving={savingNotifyEmail} saved={savedNotifyEmail}>
          <div>
            <input
              type="email"
              value={notificationEmail}
              onChange={e => setNotificationEmail(e.target.value)}
              placeholder="orders@yourrestaurant.com"
              className="w-full h-11 px-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
            />
            <p className="text-xs text-gray-400 mt-1">We'll email this address whenever a new order comes in. Leave blank to disable.</p>
          </div>
        </Section>

        {/* Website Settings (paid add-on) */}
        <WebsiteSettingsPanel
          restaurant={restaurant}
          onSave={updated => setRestaurant(updated)}
          isAdmin={false}
        />
      </div>
    </div>
  )
}
