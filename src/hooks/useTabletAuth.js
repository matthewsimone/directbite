import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useTabletAuth(slug) {
  const [session, setSession] = useState(null)
  const [restaurant, setRestaurant] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!supabase) {
      setError('Supabase is not configured.')
      setLoading(false)
      return
    }

    async function init() {
      const { data: { session: existing } } = await supabase.auth.getSession()
      if (existing) {
        const verified = await verifyRestaurant(existing)
        if (!verified) {
          setLoading(false)
          return
        }
      }
      setLoading(false)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
    })

    init()
    return () => subscription.unsubscribe()
  }, [slug])

  async function verifyRestaurant(sess) {
    // With RLS, authenticated users can only read restaurants where their email matches tablet_email.
    // So if we get a result for this slug, they're authorized.
    const { data, error: fetchErr } = await supabase
      .from('restaurants')
      .select('*')
      .eq('slug', slug)
      .single()

    if (fetchErr || !data) {
      setError('This account is not authorized for this restaurant')
      await supabase.auth.signOut()
      setSession(null)
      return false
    }

    setSession(sess)
    setRestaurant(data)
    setError(null)
    return true
  }

  async function login(email, password) {
    setError(null)
    const { data, error: authErr } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (authErr) {
      setError(authErr.message)
      return false
    }

    const verified = await verifyRestaurant(data.session)
    return verified
  }

  async function logout() {
    await supabase.auth.signOut()
    setSession(null)
    setRestaurant(null)
  }

  return { session, restaurant, setRestaurant, loading, error, login, logout }
}
