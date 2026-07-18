import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { boundedFetch } from '../lib/boundedFetch'

export function useRestaurant(slug) {
  const [restaurant, setRestaurant] = useState(null)
  const [hours, setHours] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [nextOpenTime, setNextOpenTime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Bounded-fetch UI signals: `stalled` = the 2500ms hedge started (show a
  // "still loading" hint); `failed` = the 10s hard deadline fired (show retry).
  const [stalled, setStalled] = useState(false)
  const [failed, setFailed] = useState(false)
  // Hours couldn't be loaded (timeout or error) — restaurant IS loaded, but we
  // must NOT assert open/closed (showing an open shop as CLOSED is worse than
  // showing no status). Consumers suppress the open/closed UI while set.
  const [hoursUnknown, setHoursUnknown] = useState(false)

  // Tracks whether the component is still mounted so async setState calls
  // after unmount become no-ops. Set true on every (re)mount to handle
  // React StrictMode's mount→unmount→mount cycle in dev.
  const mountedRef = useRef(true)
  // Outer controller for the current load(); a new load()/retry() or unmount
  // aborts the prior one so its bounded-fetch attempts stop and never strand.
  const loadAbortRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadAbortRef.current?.abort()
    }
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

    // Supersede any in-flight load; this one now owns loading/error/stalled/failed.
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const outerSignal = controller.signal
    // Only the current (non-superseded, still-mounted) load may write state.
    const isCurrent = () => mountedRef.current && loadAbortRef.current === controller
    // ONE shared 10s ceiling for the whole load — restaurant + hours together,
    // not 10s each. A group starting late gets only the remaining budget.
    const deadlineAt = Date.now() + 10000

    if (mountedRef.current) {
      setLoading(true)
      setError(null)
      setStalled(false)
      setFailed(false)
      setHoursUnknown(false)
    }

    try {
      const restGrp = await boundedFetch(
        [(s) => supabase.from('restaurants').select('*').eq('slug', slug).single().abortSignal(s).retry(false)],
        { deadlineAt, onStalled: () => { if (isCurrent()) setStalled(true) }, signal: outerSignal }
      )
      if (restGrp.cancelled || !isCurrent()) return
      if (restGrp.timedOut) { setFailed(true); return }
      setStalled(false)

      const { data: rest, error: restErr } = restGrp.results[0]
      if (restErr || !rest) {
        setError(restErr?.message || 'Restaurant not found')
        return
      }
      setRestaurant(rest)

      const hoursGrp = await boundedFetch(
        [(s) => supabase.from('hours').select('*').eq('restaurant_id', rest.id).order('day_of_week').abortSignal(s).retry(false)],
        { deadlineAt, onStalled: () => { if (isCurrent()) setStalled(true) }, signal: outerSignal }
      )
      if (hoursGrp.cancelled || !isCurrent()) return
      setStalled(false)

      // Hours failure OR timeout is non-fatal — the restaurant is loaded and
      // usable. Mark hoursUnknown so consumers DON'T assert closed (a stalled
      // hours fetch must not flip an open restaurant to "Closed").
      const hoursErr = hoursGrp.timedOut ? null : hoursGrp.results[0].error
      if (hoursGrp.timedOut || hoursErr) {
        if (hoursErr) console.error('useRestaurant: hours load failed', hoursErr)
        setHoursUnknown(true)
        setHours([])
        setNextOpenTime(null)
        return
      }
      const hoursData = hoursGrp.results[0].data || []
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
      if (!isCurrent()) return
      console.error('useRestaurant: load failed', err)
      setError(err?.message || 'Failed to load restaurant')
    } finally {
      // Only the current (non-superseded) load clears loading.
      if (isCurrent()) setLoading(false)
    }
  }, [slug])

  // Manual retry (Retry button / refocus-while-failed). load() aborts any
  // stale attempt and resets stalled/failed/error before re-fetching.
  const retry = useCallback(() => { load() }, [load])

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

  return { restaurant, hours, isOpen, nextOpenTime, loading, error, stalled, failed, hoursUnknown, retry }
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${h12}:${m} ${ampm}`
}
