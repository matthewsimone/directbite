// Best-effort parse of a US-style address into its parts.
// Format expected: "<street>, <city>, <STATE> <ZIP>"
// e.g. "100 Old Tappan Rd, Old Tappan, NJ 07675"
//      "19 Wanaque Ave, Pompton Lakes, NJ 07442"
//
// Returns nulls for parts that can't be confidently extracted, so callers
// can decide to omit fields (e.g. Schema.org PostalAddress) rather than
// emit garbage.

// Google Places returns addresses with a trailing ", USA" — useful to
// keep in the database for geocoding precision, but redundant for US
// customers and breaks the parser (the last comma-separated segment is
// expected to be "<STATE> <ZIP>", not "USA").
const COUNTRY_SUFFIX = /,\s*(USA|United States)\s*$/i

export function formatDisplayAddress(addr) {
  if (!addr) return ''
  return addr.replace(COUNTRY_SUFFIX, '').trim()
}

export function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') {
    return { street: null, city: null, state: null, zip: null, line2: null }
  }
  const cleaned = raw.replace(COUNTRY_SUFFIX, '').trim()
  const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length < 3) {
    return { street: cleaned, city: null, state: null, zip: null, line2: null }
  }

  const lastTokens = parts[parts.length - 1].split(/\s+/)
  // Expect at least [STATE, ZIP]; allow ZIP+4
  const state = lastTokens[0] && /^[A-Za-z]{2}$/.test(lastTokens[0]) ? lastTokens[0].toUpperCase() : null
  const zip = lastTokens[1] && /^\d{5}(-\d{4})?$/.test(lastTokens[1]) ? lastTokens[1] : null

  if (!state) {
    // Couldn't confidently parse the tail — fall back to raw line 1
    return { street: cleaned, city: null, state: null, zip: null, line2: null }
  }

  const city = parts[parts.length - 2] || null
  const street = parts.slice(0, -2).join(', ') || null

  const line2 = city && state
    ? `${city}, ${state}${zip ? ` ${zip}` : ''}`
    : null

  return { street, city, state, zip, line2 }
}
