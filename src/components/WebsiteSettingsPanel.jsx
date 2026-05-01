import { useState, useRef } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import ImageUpload from './ImageUpload'

const DEFAULT_BRAND_COLOR = '#16A34A'
const TAGLINE_MAX = 60
const ABOUT_MAX = 500
const REVIEW_TEXT_MAX = 200
const MAX_GALLERY = 8
const MAX_REVIEWS = 3

function Toggle({ value, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={`relative w-14 h-8 rounded-full transition-colors shrink-0 ${value ? 'bg-[#16A34A]' : 'bg-gray-300'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      style={{ minWidth: 56 }}
    >
      <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${value ? 'left-7' : 'left-1'}`} />
    </button>
  )
}

function Stars({ value, onChange, disabled }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => !disabled && onChange(n)}
          disabled={disabled}
          className="text-2xl leading-none"
        >
          <span className={n <= value ? 'text-yellow-400' : 'text-gray-300'}>★</span>
        </button>
      ))}
    </div>
  )
}

function GalleryGrid({ urls, onChange, disabled, slug }) {
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)

  async function handleAdd(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (urls.length >= MAX_GALLERY) {
      toast.error(`Max ${MAX_GALLERY} photos`)
      return
    }
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      toast.error('JPEG, PNG, or WebP only')
      return
    }
    setUploading(true)
    const idx = urls.length
    const path = `${slug}/gallery/${idx}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('hero-images').upload(path, file, { upsert: true })
    if (error) {
      setUploading(false)
      console.error('[GALLERY] upload failed:', error)
      toast.error(`Upload failed: ${error.message}`)
      return
    }
    const { data } = supabase.storage.from('hero-images').getPublicUrl(path)
    console.log('[GALLERY] uploaded:', data.publicUrl)
    await onChange([...urls, data.publicUrl])
    setUploading(false)
  }

  async function removeAt(i) {
    await onChange(urls.filter((_, idx) => idx !== i))
  }

  async function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= urls.length) return
    const next = [...urls]
    ;[next[i], next[j]] = [next[j], next[i]]
    await onChange(next)
  }

  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((url, i) => (
          <div key={url + i} className="relative aspect-square bg-gray-100 rounded-lg overflow-hidden group">
            <img src={url} alt={`Gallery ${i + 1}`} className="w-full h-full object-cover" />
            <button type="button" onClick={() => removeAt(i)}
              className="absolute top-1 right-1 w-6 h-6 bg-black/70 text-white rounded-full text-xs leading-none flex items-center justify-center">×</button>
            <div className="absolute bottom-1 left-1 flex gap-1">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                className="w-6 h-6 bg-black/70 text-white rounded text-xs leading-none disabled:opacity-30">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === urls.length - 1}
                className="w-6 h-6 bg-black/70 text-white rounded text-xs leading-none disabled:opacity-30">↓</button>
            </div>
          </div>
        ))}
        {urls.length < MAX_GALLERY && (
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
            className="aspect-square border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center text-gray-400 hover:border-[#16A34A] hover:text-[#16A34A] text-sm font-medium disabled:opacity-50">
            {uploading ? '...' : '+ Add Photo'}
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAdd} className="hidden" />
      <p className="text-xs text-gray-500 mt-2">{urls.length} / {MAX_GALLERY} photos</p>
    </div>
  )
}

function ReviewRow({ review, onChange, onRemove, disabled }) {
  return (
    <div className="bg-gray-50 rounded-xl p-3 space-y-2 relative">
      <button type="button" onClick={onRemove} disabled={disabled}
        className="absolute top-2 right-2 text-gray-400 hover:text-red-500 text-lg leading-none disabled:opacity-40">×</button>
      <div>
        <label className="text-xs text-gray-500">Customer Name</label>
        <input
          type="text"
          value={review.customer_name || ''}
          onChange={e => onChange({ ...review, customer_name: e.target.value })}
          disabled={disabled}
          placeholder="Christine"
          className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A] disabled:opacity-50"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 mb-1 block">Rating</label>
        <Stars value={review.stars || 0} onChange={n => onChange({ ...review, stars: n })} disabled={disabled} />
      </div>
      <div>
        <label className="text-xs text-gray-500">Review</label>
        <textarea
          rows={2}
          maxLength={REVIEW_TEXT_MAX}
          value={review.text || ''}
          onChange={e => onChange({ ...review, text: e.target.value })}
          disabled={disabled}
          placeholder="Best pizza in town..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A] disabled:opacity-50"
        />
        <p className="text-xs text-gray-400 text-right">{(review.text || '').length} / {REVIEW_TEXT_MAX}</p>
      </div>
    </div>
  )
}

function HelpText({ children }) {
  return <p className="text-xs text-gray-400 mt-1">{children}</p>
}

function SectionHeader({ children }) {
  return <h4 className="text-sm font-semibold text-gray-700 mb-2">{children}</h4>
}

export default function WebsiteSettingsPanel({ restaurant, onSave, isAdmin }) {
  const [websiteEnabled, setWebsiteEnabled] = useState(!!restaurant?.website_enabled)
  const [logoUrl, setLogoUrl] = useState(restaurant?.logo_url || null)
  const [tagline, setTagline] = useState(restaurant?.tagline || '')
  const [aboutVisible, setAboutVisible] = useState(restaurant?.about_section_visible ?? true)
  const [aboutText, setAboutText] = useState(restaurant?.about_text || '')
  const [featuredMenuVisible, setFeaturedMenuVisible] = useState(restaurant?.featured_menu_section_visible ?? true)
  const [galleryVisible, setGalleryVisible] = useState(restaurant?.gallery_section_visible ?? true)
  const [galleryUrls, setGalleryUrls] = useState(restaurant?.gallery_urls || [])
  const [reviewsVisible, setReviewsVisible] = useState(restaurant?.reviews_section_visible ?? true)
  const [reviews, setReviews] = useState(restaurant?.reviews || [])
  const [instagramUrl, setInstagramUrl] = useState(restaurant?.instagram_url || '')
  const [facebookUrl, setFacebookUrl] = useState(restaurant?.facebook_url || '')
  const [primaryColor, setPrimaryColor] = useState(restaurant?.primary_color || '')
  const [saving, setSaving] = useState(false)

  // For tablet: gate is locked. For admin: gate controls disabling fields below.
  const fieldsDisabled = !websiteEnabled

  // Auto-persist gallery on every change (upload/delete/reorder).
  // Avoids losing photos if the user clicks the panel-level Save button
  // before clicking "Save Website Settings", or navigates away.
  async function persistGallery(nextUrls) {
    setGalleryUrls(nextUrls)
    console.log('[GALLERY] persisting urls:', nextUrls)
    const { data, error } = await supabase
      .from('restaurants')
      .update({ gallery_urls: nextUrls })
      .eq('id', restaurant.id)
      .select()
      .single()
    console.log('[GALLERY] persist response:', { data, error })
    if (error) {
      toast.error(`Gallery save failed: ${error.message}`)
      return
    }
    if (onSave && data) onSave(data)
  }

  function addReview() {
    if (reviews.length >= MAX_REVIEWS) return
    setReviews([...reviews, { customer_name: '', stars: 5, text: '' }])
  }

  function updateReview(i, next) {
    setReviews(prev => prev.map((r, idx) => idx === i ? next : r))
  }

  function removeReview(i) {
    setReviews(prev => prev.filter((_, idx) => idx !== i))
  }

  function validateUrl(url) {
    if (!url) return true
    return url.startsWith('https://')
  }

  async function handleSave() {
    if (instagramUrl && !validateUrl(instagramUrl)) {
      toast.error('Instagram URL must start with https://')
      return
    }
    if (facebookUrl && !validateUrl(facebookUrl)) {
      toast.error('Facebook URL must start with https://')
      return
    }
    setSaving(true)
    const payload = {
      tagline: tagline.trim() || null,
      about_text: aboutText.trim() || null,
      about_section_visible: aboutVisible,
      gallery_section_visible: galleryVisible,
      featured_menu_section_visible: featuredMenuVisible,
      reviews_section_visible: reviewsVisible,
      logo_url: logoUrl,
      gallery_urls: galleryUrls,
      instagram_url: instagramUrl.trim() || null,
      facebook_url: facebookUrl.trim() || null,
      primary_color: primaryColor || null,
      reviews: reviews.filter(r => r.customer_name?.trim() && r.text?.trim()),
    }
    if (isAdmin) {
      payload.website_enabled = websiteEnabled
    }
    console.log('[GALLERY] saving urls:', galleryUrls)
    console.log('[WEBSITE-SETTINGS] payload:', payload)
    const { data, error } = await supabase
      .from('restaurants')
      .update(payload)
      .eq('id', restaurant.id)
      .select()
      .single()
    console.log('[GALLERY] save response:', { data, error })
    setSaving(false)
    if (error) {
      toast.error(`Save failed: ${error.message}`)
      return
    }
    toast.success('Website settings saved')
    if (onSave && data) onSave(data)
  }

  // Tablet view, website disabled — banner only.
  if (!isAdmin && !websiteEnabled) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Website Settings</h3>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
          <p className="text-sm text-blue-900 font-medium">Contact DirectBite to activate your website</p>
          <p className="text-xs text-blue-700 mt-1">A branded website is a paid add-on for DirectBite restaurants.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Website Settings</h3>

      {/* Admin master gate */}
      {isAdmin && (
        <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
          <div>
            <p className="text-sm font-semibold text-gray-800">Website Enabled</p>
            <p className="text-xs text-gray-500">Paid add-on. Locked from restaurant tablet.</p>
          </div>
          <Toggle value={websiteEnabled} onChange={setWebsiteEnabled} />
        </div>
      )}

      <div className={`space-y-6 ${fieldsDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {/* 1. Logo */}
        <div>
          <SectionHeader>Restaurant Logo</SectionHeader>
          <ImageUpload
            currentImageUrl={logoUrl}
            bucketName="hero-images"
            storagePath={`${restaurant?.slug}/logo.jpg`}
            onUpload={url => setLogoUrl(url)}
            placeholder="Upload Logo"
          />
          <HelpText>Square logos work best. Recommended 400×400 or larger. Max 10MB.</HelpText>
        </div>

        {/* 2. Tagline */}
        <div>
          <SectionHeader>Tagline</SectionHeader>
          <input
            type="text"
            value={tagline}
            maxLength={TAGLINE_MAX}
            onChange={e => setTagline(e.target.value)}
            placeholder="Authentic NJ Pizza Since 1985"
            className="w-full h-11 px-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
          <p className="text-xs text-gray-400 text-right">{tagline.length} / {TAGLINE_MAX}</p>
          <HelpText>A short one-liner shown in the hero of your website.</HelpText>
        </div>

        {/* 3. About */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show About section on website</SectionHeader>
            <Toggle value={aboutVisible} onChange={setAboutVisible} />
          </div>
          <textarea
            rows={4}
            maxLength={ABOUT_MAX}
            value={aboutText}
            onChange={e => setAboutText(e.target.value)}
            disabled={!aboutVisible}
            placeholder="Tell customers about your restaurant..."
            className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A] disabled:opacity-40 disabled:bg-gray-50"
          />
          <p className="text-xs text-gray-400 text-right">{aboutText.length} / {ABOUT_MAX}</p>
          <HelpText>Tell customers about your restaurant — your story, what makes you special.</HelpText>
        </div>

        {/* 4. Featured Menu */}
        <div>
          <div className="flex items-center justify-between">
            <SectionHeader>Show Featured Menu section on website</SectionHeader>
            <Toggle value={featuredMenuVisible} onChange={setFeaturedMenuVisible} />
          </div>
          <HelpText>Items marked “Feature on Website” in your Menu tab appear here. Toggle off to hide section entirely.</HelpText>
        </div>

        {/* 5. Gallery */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show Gallery section on website</SectionHeader>
            <Toggle value={galleryVisible} onChange={setGalleryVisible} />
          </div>
          <GalleryGrid urls={galleryUrls} onChange={persistGallery} disabled={!galleryVisible} slug={restaurant?.slug} />
          <HelpText>Up to 8 photos. Even numbers (2, 4, 6, 8) display best. Recommended: food, kitchen, or interior.</HelpText>
        </div>

        {/* 6. Reviews */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show Reviews section on website</SectionHeader>
            <Toggle value={reviewsVisible} onChange={setReviewsVisible} />
          </div>
          <div className={`space-y-3 ${!reviewsVisible ? 'opacity-40 pointer-events-none' : ''}`}>
            {reviews.map((r, i) => (
              <ReviewRow
                key={i}
                review={r}
                onChange={next => updateReview(i, next)}
                onRemove={() => removeReview(i)}
                disabled={!reviewsVisible}
              />
            ))}
            {reviews.length < MAX_REVIEWS && (
              <button type="button" onClick={addReview} disabled={!reviewsVisible}
                className="w-full h-10 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 font-semibold hover:border-[#16A34A] hover:text-[#16A34A]">
                + Add Review
              </button>
            )}
          </div>
          <HelpText>Showcase up to 3 customer reviews on your website.</HelpText>
        </div>

        {/* 7. Social Media */}
        <div>
          <SectionHeader>Social Media</SectionHeader>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500">Instagram URL</label>
              <input
                type="url"
                value={instagramUrl}
                onChange={e => setInstagramUrl(e.target.value)}
                placeholder="https://instagram.com/yourbusiness"
                className="w-full h-11 px-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Facebook URL</label>
              <input
                type="url"
                value={facebookUrl}
                onChange={e => setFacebookUrl(e.target.value)}
                placeholder="https://facebook.com/yourbusiness"
                className="w-full h-11 px-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
          </div>
          <HelpText>Optional. Linked from your website's footer. Must start with https://</HelpText>
        </div>

        {/* 8. Brand Color */}
        <div>
          <SectionHeader>Brand Color</SectionHeader>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={primaryColor || DEFAULT_BRAND_COLOR}
              onChange={e => setPrimaryColor(e.target.value)}
              className="w-12 h-11 border border-gray-300 rounded-lg cursor-pointer"
            />
            <span className="text-sm font-mono text-gray-700">{primaryColor || `${DEFAULT_BRAND_COLOR} (default)`}</span>
            {primaryColor && (
              <button type="button" onClick={() => setPrimaryColor('')}
                className="text-xs text-[#16A34A] font-semibold ml-auto">Reset to default</button>
            )}
          </div>
          <HelpText>Used for buttons on your website.</HelpText>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-xl hover:bg-[#15803D] disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving...' : 'Save Website Settings'}
      </button>
    </div>
  )
}
