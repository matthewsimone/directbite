import { useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import ImageUpload from '../../components/ImageUpload'

const RESERVED_PATHS = ['home', 'checkout', 'confirmation', 'tablet', 'order', 'admin', 'privacy', 'terms', 'applepay-test', 'login']
const PATH_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `lnk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default function WebsiteLinksEditor({ restaurant, setRestaurant }) {
  const [links, setLinks] = useState(() => Array.isArray(restaurant?.website_links) ? restaurant.website_links : [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const slug = restaurant?.slug

  function updateLink(id, patch) {
    setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }
  function onLabelChange(id, label) {
    setLinks((prev) => prev.map((l) => {
      if (l.id !== id) return l
      const next = { ...l, label }
      if (!l.path) next.path = slugify(label)
      return next
    }))
  }
  function addLink() {
    setLinks((prev) => [...prev, { id: genId(), label: '', path: '', href: '' }])
  }
  function removeLink(id) {
    setLinks((prev) => prev.filter((l) => l.id !== id))
  }
  function move(id, dir) {
    setLinks((prev) => {
      const i = prev.findIndex((l) => l.id === id)
      if (i < 0) return prev
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  function validate() {
    const seen = new Set()
    for (const l of links) {
      const label = (l.label || '').trim()
      const path = (l.path || '').trim().toLowerCase()
      if (!label || !path || !l.href) return 'Each link needs a label, a URL path, and an uploaded PDF.'
      if (!PATH_RE.test(path)) return `Path "${path}" can only use lowercase letters, numbers, and hyphens.`
      if (RESERVED_PATHS.includes(path)) return `"${path}" is a reserved path — choose another.`
      if (seen.has(path)) return `Duplicate path "${path}". Each link needs a unique path.`
      seen.add(path)
    }
    return null
  }
  async function saveLinks() {
    const err = validate()
    if (err) { toast.error(err); return }
    const clean = links.map((l) => ({ id: l.id, label: l.label.trim(), path: l.path.trim().toLowerCase(), href: l.href }))
    setSaving(true); setSaved(false)
    const { data, error } = await supabase.from('restaurants').update({ website_links: clean }).eq('id', restaurant.id).select().single()
    setSaving(false)
    if (error || !data) { toast.error("Couldn't save links. Try again."); return }
    setRestaurant(data)
    setLinks(Array.isArray(data.website_links) ? data.website_links : clean)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Menus & Links</h3>
      <p className="text-xs text-gray-400">Add PDF menus or info pages to your website navigation (e.g. Catering Menu, Lunch Specials).</p>
      {links.length === 0 && <p className="text-sm text-gray-400">No links yet.</p>}
      <div className="space-y-4">
        {links.map((link, idx) => (
          <div key={link.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">Link {idx + 1}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => move(link.id, 'up')} disabled={idx === 0} className="px-2 py-1 text-gray-500 disabled:opacity-30" aria-label="Move up">↑</button>
                <button onClick={() => move(link.id, 'down')} disabled={idx === links.length - 1} className="px-2 py-1 text-gray-500 disabled:opacity-30" aria-label="Move down">↓</button>
                <button onClick={() => removeLink(link.id)} className="px-2 py-1 text-red-500 text-sm" aria-label="Remove">Remove</button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Label (shown in nav)</label>
              <input type="text" value={link.label} onChange={(e) => onLabelChange(link.id, e.target.value)} placeholder="Catering Menu" className="w-full h-11 px-3 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">URL path</label>
              <div className="flex items-center">
                <span className="text-sm text-gray-400 mr-1">/</span>
                <input type="text" value={link.path} onChange={(e) => updateLink(link.id, { path: e.target.value })} placeholder="catering" className="flex-1 h-11 px-3 border border-gray-300 rounded-lg text-sm" />
              </div>
              <p className="text-xs text-gray-400 mt-1">Appears at {restaurant?.custom_domain || 'yoursite.com'}/{link.path || 'catering'}</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">PDF</label>
              <ImageUpload accept="pdf" maxSizeMB={10} currentImageUrl={link.href} bucketName="restaurant-files" storagePath={`${slug}/${link.id}.pdf`} onUpload={(url) => updateLink(link.id, { href: url })} placeholder={link.href ? 'Replace PDF' : 'Upload PDF'} />
            </div>
          </div>
        ))}
      </div>
      <button onClick={addLink} className="w-full h-11 border border-dashed border-gray-300 text-gray-600 font-medium rounded-xl hover:bg-gray-50 transition-colors">+ Add Link</button>
      <button onClick={saveLinks} disabled={saving} className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors">{saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}</button>
    </div>
  )
}
