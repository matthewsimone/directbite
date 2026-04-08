import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useRestaurant(slug) {
  const [restaurant, setRestaurant] = useState(null)
  const [hours, setHours] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [nextOpenTime, setNextOpenTime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!slug) return
    if (!supabase) {
      setError('Supabase is not configured. Check your .env file.')
      setLoading(false)
      return
    }

    async function fetch() {
      setLoading(true)
      const { data: rest, error: restErr } = await supabase
        .from('restaurants')
        .select('*')
        .eq('slug', slug)
        .single()

      if (restErr || !rest) {
        setError(restErr?.message || 'Restaurant not found')
        setLoading(false)
        return
      }

      setRestaurant(rest)

      const { data: hoursData } = await supabase
        .from('hours')
        .select('*')
        .eq('restaurant_id', rest.id)
        .order('day_of_week')

      setHours(hoursData || [])

      // Check if currently open
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

      // Find next open time if currently closed
      if (!open) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        for (let i = 0; i < 7; i++) {
          const checkDay = (dayOfWeek + i) % 7
          const h = (hoursData || []).find(hr => hr.day_of_week === checkDay)
          if (h?.is_open && h.open_time) {
            if (i === 0 && currentTime < h.open_time) {
              setNextOpenTime(`today at ${formatTime(h.open_time)}`)
              break
            } else if (i > 0) {
              setNextOpenTime(`${dayNames[checkDay]} at ${formatTime(h.open_time)}`)
              break
            }
          }
        }
      }

      setLoading(false)
    }

    fetch()
  }, [slug])

  return { restaurant, hours, isOpen, nextOpenTime, loading, error }
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${h12}:${m} ${ampm}`
}
