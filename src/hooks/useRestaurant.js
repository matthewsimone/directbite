import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

export function useRestaurant(slug) {
  const [restaurant, setRestaurant] = useState(null)
  const [hours, setHours] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [nextOpenTime, setNextOpenTime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Tracks whether the component is still mounted so async setState calls
  // after unmount become no-ops. Set true on every (re)mount to handle
  // React StrictMode's mount→unmount→mount cycle in dev.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!slug) return
    if (!supabase) {
      if (mountedRef.current) {
        setError('Supabase is not configured. Check your .env file.')
        setLoading(false)
      }
      return
    }

    if (mountedRef.current) {
      setLoading(true)
      setError(null)
    }

    try {
      const { data: rest, error: restErr } = await supabase
        .from('restaurants')
        .select('*')
        .eq('slug', slug)
        .single()

      if (!mountedRef.current) return
      if (restErr || !rest) {
        setError(restErr?.message || 'Restaurant not found')
        return
      }
      setRestaurant(rest)

      const { data: hoursData, error: hoursErr } = await supabase
        .from('hours')
        .select('*')
        .eq('restaurant_id', rest.id)
        .order('day_of_week')

      if (!mountedRef.current) return
      if (hoursErr) {
        // Hours failure is non-fatal — restaurant is loaded; show as
        // closed with no nextOpenTime rather than blocking the page.
        console.error('useRestaurant: hours load failed', hoursErr)
        setHours([])
        setIsOpen(false)
        setNextOpenTime(null)
        return
      }
      setHours(hoursData || [])

      const now = new Date()
      const dayOfWeek = now.getDay()
      const currentTime = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })

      const todayHours = (hoursData || []).find(h => h.day_of_week === dayOfWeek)
      let open = false

      if (rest.is_open && todayHours?.is_open && todayHours.open_time && todayHours.close_time) {
        open = currentTime >= todayHours.open_time && currentTime <= todayHours.close_time
      }

      setIsOpen(open)

      if (!open) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        let resolved = null
        for (let i = 0; i < 7; i++) {
          const checkDay = (dayOfWeek + i) % 7
          const h = (hoursData || []).find(hr => hr.day_of_week === checkDay)
          if (h?.is_open && h.open_time) {
            if (i === 0 && currentTime < h.open_time) {
              resolved = `today at ${formatTime(h.open_time)}`
              break
            } else if (i > 0) {
              resolved = `${dayNames[checkDay]} at ${formatTime(h.open_time)}`
              break
            }
          }
        }
        setNextOpenTime(resolved)
      } else {
        setNextOpenTime(null)
      }
    } catch (err) {
      if (!mountedRef.current) return
      console.error('useRestaurant: load failed', err)
      setError(err?.message || 'Failed to load restaurant')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    load()
  }, [load])

  // Phone backgrounded → returned: re-run the fetch in case the in-flight
  // request was suspended and never resolved, or hours rolled over while
  // away (open/closed status drifts).
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [load])

  return { restaurant, hours, isOpen, nextOpenTime, loading, error }
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${h12}:${m} ${ampm}`
}
