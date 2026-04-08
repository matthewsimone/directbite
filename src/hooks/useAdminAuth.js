import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || ''

export function useAdminAuth() {
  const [session, setSession] = useState(null)
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
        if (existing.user.email !== ADMIN_EMAIL) {
          setError('Access denied')
          await supabase.auth.signOut()
        } else {
          setSession(existing)
        }
      }
      setLoading(false)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (sess && sess.user.email !== ADMIN_EMAIL) {
        setError('Access denied')
        supabase.auth.signOut()
        setSession(null)
      } else {
        setSession(sess)
      }
    })

    init()
    return () => subscription.unsubscribe()
  }, [])

  async function login(email, password) {
    setError(null)
    const { data, error: authErr } = await supabase.auth.signInWithPassword({ email, password })

    if (authErr) {
      setError(authErr.message)
      return false
    }

    if (data.session.user.email !== ADMIN_EMAIL) {
      setError('Access denied')
      await supabase.auth.signOut()
      return false
    }

    setSession(data.session)
    return true
  }

  async function logout() {
    await supabase.auth.signOut()
    setSession(null)
  }

  return { session, loading, error, login, logout }
}
