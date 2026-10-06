// DSP provider → display label/name + tablet badge classes. Plain module (no
// React) so both the tablet tiles and the Epson ticket builder can use it.
// provider_id values are KitchenHub's; matched loosely and falls back to
// provider_name so an unexpected id still renders something readable.

// Normalized provider key shared by providerDisplay and providerIcon.
function providerKey(o) {
  return String(o?.provider_id || o?.provider_name || '').toLowerCase().replace(/[^a-z]/g, '')
}

export function providerDisplay(o) {
  const key = providerKey(o)
  if (key.includes('doordash')) return { label: 'DOORDASH', name: 'DoorDash', cls: 'bg-red-600 text-white', border: 'border-l-red-600' }
  if (key.includes('uber')) return { label: 'UBER EATS', name: 'Uber Eats', cls: 'bg-black text-white', border: 'border-l-black' }
  if (key.includes('grubhub')) return { label: 'GRUBHUB', name: 'Grubhub', cls: 'bg-orange-500 text-white', border: 'border-l-orange-500' }
  const raw = String(o?.provider_name || o?.provider_id || 'DSP')
  return { label: raw.toUpperCase(), name: raw, cls: 'bg-gray-700 text-white', border: 'border-l-gray-700' }
}

// Static app icons: public/dsp-icons/*.png (192px, pre-rounded corners).
// ?v= cache-buster: bump it when an icon file is replaced, so kiosk tablets
// don't keep showing a cached copy.
export const ORDR_ICON = '/dsp-icons/ordr.png?v=1'

// { src, initials, name } — src is null for an unknown provider; callers then
// draw a gray rounded square with the initials.
export function providerIcon(o) {
  const key = providerKey(o)
  const src = key.includes('doordash') ? '/dsp-icons/doordash.png?v=1'
    : key.includes('uber') ? '/dsp-icons/ubereats.png?v=1'
    : key.includes('grubhub') ? '/dsp-icons/grubhub.png?v=1'
    : null
  const name = providerDisplay(o).name
  const initials = name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'
  return { src, initials, name }
}

// Escalation threshold for DSP orders: acknowledged (tapped) but still 'new'
// (not accepted) for this many minutes drives the escalation alert layer.
// Shorter than the Ordr ESCALATION_MINUTES (7) because DoorDash / Uber Eats /
// Grubhub auto-cancel unaccepted orders within ~5-15 minutes. Shared by
// useOrderPolling (audio) and ExternalOrderCard (tile) so they can't drift.
export const DSP_ESCALATION_MINUTES = 3

// KitchenHub order numbers can arrive already prefixed ("#A1B2"); strip one
// leading '#' so callers add their own without showing "##".
export function dspOrderNumber(o) {
  const raw = o?.order_number ?? o?.daily_number
  if (raw == null) return null
  const s = String(raw).trim().replace(/^#/, '')
  return s || null
}
