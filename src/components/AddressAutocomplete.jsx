import { useState, useEffect, useRef } from 'react'

let mapsLoadPromise = null

function loadMaps() {
  console.log('[AA] loadMaps called, already loaded:', !!window.google?.maps?.places, 'pending:', !!mapsLoadPromise)
  if (window.google?.maps?.places) return Promise.resolve()
  if (mapsLoadPromise) return mapsLoadPromise
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  console.log('[AA] API key present:', !!apiKey)
  if (!apiKey) return Promise.reject(new Error('No Google Maps API key'))
  mapsLoadPromise = import('@googlemaps/js-api-loader').then(({ Loader }) => {
    console.log('[AA] dynamic import succeeded, creating Loader')
    const loader = new Loader({ apiKey, libraries: ['places'] })
    return loader.load()
  }).then((result) => {
    console.log('[AA] Google Maps loaded successfully, places available:', !!window.google?.maps?.places)
    return result
  }).catch(err => {
    console.error('[AA] loadMaps failed:', err)
    mapsLoadPromise = null
    throw err
  })
  return mapsLoadPromise
}

export default function AddressAutocomplete({ defaultValue, onSelect, onChange, className }) {
  const inputRef = useRef(null)
  const acRef = useRef(null)
  const [loaded, setLoaded] = useState(!!window.google?.maps?.places)

  useEffect(() => {
    console.log('[AA] mount effect, loaded:', loaded, 'key present:', !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY)
    if (loaded) return
    loadMaps().then(() => {
      console.log('[AA] setLoaded(true)')
      setLoaded(true)
    }).catch(err => console.error('[AA] loadMaps rejected:', err))
  }, [loaded])

  useEffect(() => {
    console.log('[AA] autocomplete effect, loaded:', loaded, 'inputRef:', !!inputRef.current, 'acRef:', !!acRef.current)
    if (!loaded || !inputRef.current || acRef.current) return
    console.log('[AA] attaching autocomplete to input')
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
