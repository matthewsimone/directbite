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

// Same rounded-hexagon path used on the hero.
const ROUNDED_HEXAGON_PATH = [
  'M 55.4,2.7',
  'L 94.6,22.3', 'Q 100,25 100,31',
  'L 100,69',    'Q 100,75 94.6,77.7',
  'L 55.4,97.3', 'Q 50,100 44.6,97.3',
  'L 5.4,77.7',  'Q 0,75 0,69',
  'L 0,31',      'Q 0,25 5.4,22.3',
  'L 44.6,2.7',  'Q 50,0 55.4,2.7',
  'Z',
].join(' ')

const FRAME_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'circle', label: 'Circle' },
  { value: 'pill_horizontal', label: 'Horizontal Oval' },
  { value: 'pill_vertical', label: 'Vertical Oval' },
  { value: 'hexagon', label: 'Hexagon' },
]

function FramePreview({ shape, color }) {
  // Mini version of the actual hero badge: white fill + brand border +
  // thin white trim outside, with a gray dot standing in for the logo.
  const ovalStyle = {
    borderRadius: '50%',
    boxShadow: `0 0 0 1.5px ${color}, 0 0 0 3px white`,
  }
  const dotCls = 'w-1.5 h-1.5 rounded-full bg-gray-400'
  return (
    <div className="w-12 h-12 flex items-center justify-center bg-gray-100 rounded">
      {shape === 'none' && (
        <span className="text-[10px] uppercase tracking-wider text-gray-400">none</span>
      )}
      {shape === 'circle' && (
        <div className="w-7 h-7 bg-white flex items-center justify-center" style={ovalStyle}>
          <span className={dotCls} />
        </div>
      )}
      {shape === 'pill_horizontal' && (
        <div className="w-10 h-5 bg-white flex items-center justify-center" style={ovalStyle}>
          <span className={dotCls} />
        </div>
      )}
      {shape === 'pill_vertical' && (
        <div className="w-5 h-10 bg-white flex items-center justify-center" style={ovalStyle}>
          <span className={dotCls} />
        </div>
      )}
      {shape === 'hexagon' && (
        <svg viewBox="0 0 100 100" className="w-8 h-8" style={{ overflow: 'visible' }}>
          <path d={ROUNDED_HEXAGON_PATH} fill="white" stroke="white" strokeWidth="13" strokeLinejoin="round" />
          <path d={ROUNDED_HEXAGON_PATH} fill="none" stroke={color} strokeWidth="6" strokeLinejoin="round" />
          <circle cx="50" cy="50" r="9" fill="#9ca3af" />
        </svg>
      )}
    </div>
  )
}

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
  const [logoFrameShape, setLogoFrameShape] = useState(restaurant?.logo_frame_shape || 'none')
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
  const [customDomain, setCustomDomain] = useState(restaurant?.custom_domain || '')
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

  // Auto-persist the admin-only website_enabled gate. Same rationale as
  // gallery: this is a high-stakes flag that must reach the DB the moment
  // the toggle flips, regardless of any batched Save button.
  async function persistWebsiteEnabled(next) {
    setWebsiteEnabled(next)
    console.log('[WEBSITE-ENABLED] persisting:', next)
    const { data, error } = await supabase
      .from('restaurants')
      .update({ website_enabled: next })
      .eq('id', restaurant.id)
      .select()
      .single()
    console.log('[WEBSITE-ENABLED] persist response:', { data, error })
    if (error) {
      toast.error(`Failed to ${next ? 'enable' : 'disable'} website: ${error.message}`)
      setWebsiteEnabled(!next)
      return
    }
    toast.success(next ? 'Website enabled' : 'Website disabled')
    if (onSave && data) onSave(data)
  }

  // Section-visibility toggles auto-persist on change so they don't
  // depend on the user clicking the panel's "Save Website Settings"
  // button (or, in the admin manage panel, accidentally clicking the
  // modal-level "Save Changes" button which doesn't touch these fields).
  async function persistVisibility(field, next, setLocal) {
    setLocal(next)
    const { data, error } = await supabase
      .from('restaurants')
      .update({ [field]: next })
      .eq('id', restaurant.id)
      .select()
      .single()
    if (error) {
      toast.error(`Failed to update visibility: ${error.message}`)
      setLocal(!next)
      return
    }
    if (onSave && data) onSave(data)
  }

  // Logo frame shape auto-persists on selection — same rationale as
  // visibility toggles. Reverts to previous value if the write fails.
  async function persistLogoFrameShape(next) {
    const previous = logoFrameShape
    setLogoFrameShape(next)
    const { data, error } = await supabase
      .from('restaurants')
      .update({ logo_frame_shape: next })
      .eq('id', restaurant.id)
      .select()
      .single()
    if (error) {
      toast.error(`Failed to save frame: ${error.message}`)
      setLogoFrameShape(previous)
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

  function normalizeCustomDomain(raw) {
    return (raw || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
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
    const cleanedDomain = normalizeCustomDomain(customDomain)
    if (cleanedDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleanedDomain)) {
      toast.error('Invalid custom domain — use a bare hostname like frankspizzaoakland.com')
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
      logo_frame_shape: logoFrameShape,
      gallery_urls: galleryUrls,
      instagram_url: instagramUrl.trim() || null,
      facebook_url: facebookUrl.trim() || null,
      primary_color: primaryColor || null,
      reviews: reviews.filter(r => r.customer_name?.trim() && r.text?.trim()),
    }
    if (isAdmin) {
      payload.website_enabled = websiteEnabled
      payload.custom_domain = cleanedDomain || null
    }
    console.log('[SAVE] payload:', payload)
    const { data, error } = await supabase
      .from('restaurants')
      .update(payload)
      .eq('id', restaurant.id)
      .select()
      .single()
    console.log('[SAVE] response:', { data, error })
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
          <Toggle value={websiteEnabled} onChange={persistWebsiteEnabled} />
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

          <div className="mt-4">
            <SectionHeader>Logo Frame Style</SectionHeader>
            <div className="grid grid-cols-5 gap-2">
              {FRAME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => persistLogoFrameShape(opt.value)}
                  className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors ${
                    logoFrameShape === opt.value
                      ? 'border-[#16A34A] bg-green-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <FramePreview shape={opt.value} color={primaryColor || DEFAULT_BRAND_COLOR} />
                  <span className="text-[10px] font-medium text-gray-700 leading-tight text-center">
                    {opt.label}
                  </span>
                </button>
              ))}
            </div>
            <HelpText>
              Choose how your logo displays on the website. “None” shows your logo as-is on a transparent background — best for circular or hexagonal logos that already have their own design. Use a frame for logos that look better with a white background container.
            </HelpText>
          </div>
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

        {/* 3. Featured */}
        <div>
          <div className="flex items-center justify-between">
            <SectionHeader>Show Featured section on website</SectionHeader>
            <Toggle
              value={featuredMenuVisible}
              onChange={next => persistVisibility('featured_menu_section_visible', next, setFeaturedMenuVisible)}
            />
          </div>
          <HelpText>Items marked “Feature on Website” in your Menu tab appear here. Toggle off to hide section entirely.</HelpText>
        </div>

        {/* 4. About */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show About section on website</SectionHeader>
            <Toggle
              value={aboutVisible}
              onChange={next => persistVisibility('about_section_visible', next, setAboutVisible)}
            />
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

        {/* 5. Gallery */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show Gallery section on website</SectionHeader>
            <Toggle
              value={galleryVisible}
              onChange={next => persistVisibility('gallery_section_visible', next, setGalleryVisible)}
            />
          </div>
          <GalleryGrid urls={galleryUrls} onChange={persistGallery} disabled={!galleryVisible} slug={restaurant?.slug} />
          <HelpText>Up to 8 photos. Even numbers (2, 4, 6, 8) display best. Recommended: food, kitchen, or interior.</HelpText>
        </div>

        {/* 6. Reviews */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionHeader>Show Reviews section on website</SectionHeader>
            <Toggle
              value={reviewsVisible}
              onChange={next => persistVisibility('reviews_section_visible', next, setReviewsVisible)}
            />
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

      {/* Admin-only: custom domain. Sits outside the websiteEnabled-gated
          block so it can still be configured even if the website is off. */}
      {isAdmin && (
        <div className="border-t border-gray-100 pt-5">
          <SectionHeader>Custom Domain (Admin Only)</SectionHeader>
          <input
            type="text"
            value={customDomain}
            onChange={e => setCustomDomain(e.target.value.toLowerCase())}
            placeholder="frankspizzaoakland.com"
            className="w-full h-11 px-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
          />
          <p className={`text-xs mt-1 font-medium ${customDomain ? 'text-green-700' : 'text-gray-400'}`}>
            {customDomain ? 'Configured' : 'Not Set'}
          </p>
          <HelpText>
            After entering, manually add this domain to Vercel via the dashboard.
            DNS records will be displayed there for the restaurant to configure at their registrar.
          </HelpText>
        </div>
      )}

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
