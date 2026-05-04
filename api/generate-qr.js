import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'

const ORIGIN = 'https://directbite.co'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const qrApiKey = process.env.SUPABASE_QR_API_KEY
  if (!supabaseUrl || !qrApiKey) {
    console.error('[generate-qr] Missing env: VITE_SUPABASE_URL or SUPABASE_QR_API_KEY')
    return res.status(500).json({ error: 'Server not configured' })
  }

  // Auth: caller must be an admin. Verify the bearer token resolves to
  // a user whose email is in admin_users.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  const supabase = createClient(supabaseUrl, qrApiKey)
  const { data: userResult, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !userResult?.user?.email) {
    return res.status(401).json({ error: 'invalid token' })
  }

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('email')
    .eq('email', userResult.user.email)
    .maybeSingle()
  if (!adminRow) return res.status(403).json({ error: 'forbidden' })

  const slug = (req.body && req.body.slug) ? String(req.body.slug).trim() : ''
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' })
  }

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id, slug')
    .eq('slug', slug)
    .maybeSingle()
  if (!restaurant) return res.status(404).json({ error: 'restaurant not found' })

  // Error correction Q (~25% recovery) handles a logo overlay or
  // sticker scuffing without making the code dense.
  const targetUrl = `${ORIGIN}/r/${slug}`
  let svg
  try {
    svg = await QRCode.toString(targetUrl, {
      type: 'svg',
      errorCorrectionLevel: 'Q',
      margin: 4,
      width: 1024,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (err) {
    return res.status(500).json({ error: 'qr generation failed', detail: err.message })
  }

  const path = `${slug}.svg`
  const { error: uploadErr } = await supabase.storage
    .from('qr-codes')
    .upload(path, svg, {
      contentType: 'image/svg+xml',
      cacheControl: '3600',
      upsert: true,
    })
  if (uploadErr) {
    return res.status(500).json({ error: 'upload failed', detail: uploadErr.message })
  }

  const { data: pub } = supabase.storage.from('qr-codes').getPublicUrl(path)
  const publicUrl = pub.publicUrl

  const { error: updateErr } = await supabase
    .from('restaurants')
    .update({ qr_code_url: publicUrl })
    .eq('id', restaurant.id)
  if (updateErr) {
    return res.status(500).json({ error: 'db update failed', detail: updateErr.message })
  }

  return res.status(200).json({ success: true, qr_code_url: publicUrl })
}
