import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function usePromotion(restaurantId) {
  const [promotion, setPromotion] = useState(null)

  useEffect(() => {
    if (!restaurantId || !supabase) return

    async function fetch() {
      const today = new Date().toISOString().split('T')[0]

      const { data } = await supabase
        .from('promotions')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true)
        .limit(1)

      if (data && data.length > 0) {
        const promo = data[0]
        if (promo.is_perpetual) {
          setPromotion(promo)
        } else if (promo.start_date && promo.end_date) {
          if (today >= promo.start_date && today <= promo.end_date) {
            setPromotion(promo)
          }
        }
      }
    }

    fetch()
  }, [restaurantId])

  function applyDiscount(price) {
    if (!promotion) return price
    return price * (1 - Number(promotion.discount_percentage) / 100)
  }

  return { promotion, applyDiscount }
}
