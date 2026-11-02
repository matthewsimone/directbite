import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { boundedFetch } from '../lib/boundedFetch'
import { isServiceConfigured, getEffectiveSchedule, isOpenAt, getNextOpen } from '../utils/serviceHours'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function useRestaurant(slug) {
  const [restaurant, setRestaurant] = useState(null)
  const [hours, setHours] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  // Per-service open state + effective schedules (serviceHours.js). For a
  // restaurant with no pickup_schedule/delivery_schedule, both services
  // mirror isOpen and both schedules are the legacy `hours` schedule.
  const [isPickupOpen, setIsPickupOpen] = useState(false)
  const [isDeliveryOpen, setIsDeliveryOpen] = useState(false)
  const [pickupSchedule, setPickupSchedule] = useState(null)
  const [deliverySchedule, setDeliverySchedule] = useState(null)
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
        // Configured schedules don't need `hours`; unconfigured ones resolve
        // to null here (no slots), same as hours = [] today. Open states are
        // deliberately left untouched, exactly like isOpen.
        setPickupSchedule(getEffectiveSchedule(rest, [], 'pickup'))
        setDeliverySchedule(getEffectiveSchedule(rest, [], 'delivery'))
        setNextOpenTime(null)
        return
      }
      const hoursData = hoursGrp.results[0].data || []
      setHours(hoursData || [])

      const pickup = getEffectiveSchedule(rest, hoursData, 'pickup')
      const delivery = getEffectiveSchedule(rest, hoursData, 'delivery')
      setPickupSchedule(pickup)
      setDeliverySchedule(delivery)

      const now = new Date()

      // Configured restaurant: each service follows its own schedule. The
      // manual is_open toggle gates both, as it gates isOpen below. A null
      // schedule (no config, no hours) is closed here — isOpenAt(null) is
      // "no info = open", which would flip empty-hours restaurants to Open.
      if (isServiceConfigured(rest)) {
        const pickupOpen = !!rest.is_open && pickup !== null && isOpenAt(pickup, now)
        const deliveryOpen = !!rest.is_open && delivery !== null && isOpenAt(delivery, now)
        const anyOpen = pickupOpen || (!!rest.delivery_available && deliveryOpen)
        setIsPickupOpen(pickupOpen)
        setIsDeliveryOpen(deliveryOpen)
        setIsOpen(anyOpen)
        if (anyOpen) {
          setNextOpenTime(null)
        } else {
          // daysAhead 6 = today..today+6, the same range as the legacy loop.
          const starts = [pickup, rest.delivery_available ? delivery : null]
            .map(s => getNextOpen(s, now, 6))
            .filter(Boolean)
          const next = starts.length > 0 ? new Date(Math.min(...starts.map(d => d.getTime()))) : null
          setNextOpenTime(next ? formatNextOpen(next, now) : null)
        }
        return
      }

      // Unconfigured: legacy `hours` logic, unchanged.
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
      setIsPickupOpen(open)
      setIsDeliveryOpen(open)

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

  return {
    restaurant, hours, isOpen, nextOpenTime, loading, error, stalled, failed, hoursUnknown, retry,
    pickupSchedule, deliverySchedule, isPickupOpen, isDeliveryOpen,
  }
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${h12}:${m} ${ampm}`
}

// Same "today at 4:30 PM" / "Thursday at 4:30 PM" wording as the legacy loop.
function formatNextOpen(next, now) {
  const hhmm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  const day = next.toDateString() === now.toDateString() ? 'today' : DAY_NAMES[next.getDay()]
  return `${day} at ${formatTime(hhmm)}`
}
