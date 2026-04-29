import { useState, useEffect, useRef } from 'react'

let mapsLoadPromise = null

function loadMaps() {
  if (window.google?.maps?.places) return Promise.resolve()
  if (mapsLoadPromise) return mapsLoadPromise
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  if (!apiKey) return Promise.reject(new Error('No Google Maps API key'))
  mapsLoadPromise = import('@googlemaps/js-api-loader').then(({ Loader }) => {
    const loader = new Loader({ apiKey, libraries: ['places'] })
    return loader.load()
  })
  return mapsLoadPromise
}

export default function AddressAutocomplete({ defaultValue, onSelect, onChange, className }) {
  const inputRef = useRef(null)
  const acRef = useRef(null)
  const [loaded, setLoaded] = useState(!!window.google?.maps?.places)

  useEffect(() => {
    if (loaded) return
    loadMaps().then(() => setLoaded(true)).catch(() => {})
  }, [loaded])

  useEffect(() => {
    if (!loaded || !inputRef.current || acRef.current) return
    const ac = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: 'us' },
      types: ['address'],
      fields: ['formatted_address', 'geometry'],
    })
    ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (place?.geometry?.location) {
        const addr = place.formatted_address || ''
        const lat = place.geometry.location.lat()
        const lon = place.geometry.location.lng()
        if (inputRef.current) inputRef.current.value = addr
        onSelect(addr, lat, lon)
      }
    })
    acRef.current = ac
  }, [loaded])

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={defaultValue}
      onChange={e => onChange?.(e.target.value)}
      placeholder="Search for address..."
      className={className || 'w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]'}
    />
  )
}
