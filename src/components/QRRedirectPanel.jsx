import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const ORIGIN = 'https://directbite.co'

function QuickSetButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2.5 py-1 rounded-md border border-gray-300 hover:bg-gray-50"
    >
      {label}
    </button>
  )
}

export default function QRRedirectPanel({ restaurant, onUpdate }) {
  const [redirectUrl, setRedirectUrl] = useState(restaurant.redirect_url || '')
  const [qrCodeUrl, setQrCodeUrl] = useState(restaurant.qr_code_url || '')
  const [savingUrl, setSavingUrl] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState('')
  const [scans, setScans] = useState({ last7: 0, last30: 0, loading: true })

  useEffect(() => {
    setRedirectUrl(restaurant.redirect_url || '')
    setQrCodeUrl(restaurant.qr_code_url || '')
  }, [restaurant.id, restaurant.redirect_url, restaurant.qr_code_url])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from('scans')
        .select('scanned_at')
        .eq('restaurant_id', restaurant.id)
        .gte('scanned_at', since)
      if (cancelled) return
      const sevenAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const last30 = data?.length || 0
      const last7 = data?.filter(r => new Date(r.scanned_at).getTime() > sevenAgo).length || 0
      setScans({ last7, last30, loading: false })
    }
    load()
    return () => { cancelled = true }
  }, [restaurant.id])

  const handleSaveUrl = useCallback(async () => {
    setSavingUrl(true); setMessage('')
    const { data, error } = await supabase
      .from('restaurants')
      .update({ redirect_url: redirectUrl || null })
      .eq('id', restaurant.id)
      .select()
      .single()
    setSavingUrl(false)
    if (error) { setMessage(`Save failed: ${error.message}`); return }
    setMessage('Saved')
    setTimeout(() => setMessage(''), 2000)
    if (data && onUpdate) onUpdate(data)
  }, [redirectUrl, restaurant.id, onUpdate])

  const handleGenerate = useCallback(async () => {
    setGenerating(true); setMessage('')
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/generate-qr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ slug: restaurant.slug }),
    })
    const result = await res.json()
    setGenerating(false)
    if (!result.success) {
      setMessage(`QR generation failed: ${result.error || 'unknown'}`)
      return
    }
    setQrCodeUrl(`${result.qr_code_url}?t=${Date.now()}`)
    setMessage('QR generated')
    setTimeout(() => setMessage(''), 2000)
    if (onUpdate) onUpdate({ ...restaurant, qr_code_url: result.qr_code_url })
  }, [restaurant, onUpdate])

  const orderingUrl = `${ORIGIN}/${restaurant.slug}`
  const websiteUrl = `${ORIGIN}/${restaurant.slug}/home`
  const customDomainUrl = restaurant.custom_domain ? `https://${restaurant.custom_domain}` : null

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">QR Code & Redirect</h4>

      <div>
        <label className="text-xs text-gray-500">QR Slug</label>
        <p className="font-mono text-sm py-1.5">{ORIGIN}/r/{restaurant.slug}</p>
      </div>

      <div>
        <label className="text-xs text-gray-500">Redirect URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            value={redirectUrl}
            onChange={e => setRedirectUrl(e.target.value)}
            placeholder={orderingUrl}
            className="flex-1 h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
          <button
            onClick={handleSaveUrl}
            disabled={savingUrl}
            className="px-3 h-9 bg-[#16A34A] text-white text-sm font-semibold rounded-lg disabled:opacity-50"
          >
            {savingUrl ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          <QuickSetButton label="Ordering page" onClick={() => setRedirectUrl(orderingUrl)} />
          <QuickSetButton label="Website" onClick={() => setRedirectUrl(websiteUrl)} />
          {customDomainUrl && (
            <QuickSetButton label="Custom domain" onClick={() => setRedirectUrl(customDomainUrl)} />
          )}
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-500 block mb-1">QR Code</label>
        <div className="flex items-center gap-2">
          {qrCodeUrl ? (
            <a
              href={qrCodeUrl}
              download={`${restaurant.slug}-qr.svg`}
              className="px-3 h-9 inline-flex items-center rounded-lg border border-gray-300 text-sm font-semibold hover:bg-gray-50"
            >
              Download QR
            </a>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-3 h-9 rounded-lg border border-[#16A34A] text-[#16A34A] text-sm font-semibold hover:bg-green-50 disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate QR'}
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-3 h-9 rounded-lg border border-gray-300 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-500 block mb-1">Scans</label>
        {scans.loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <p className="text-sm">
            <span className="font-semibold">{scans.last7}</span> in the last 7 days ·{' '}
            <span className="font-semibold">{scans.last30}</span> in the last 30 days
          </p>
        )}
      </div>

      {message && <p className="text-sm text-center text-[#16A34A] bg-green-50 rounded p-2">{message}</p>}
    </div>
  )
}
