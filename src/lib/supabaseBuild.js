// ============================================================================
// supabaseBuild.js — SSR/build-time Supabase client (NOT the browser client)
// ============================================================================
//
// Used ONLY at build time by the SSG prerender step to fetch page data in a
// DOM-less Node context. Deliberately separate from src/lib/supabase.js:
//   - persistSession: false   — no localStorage/auth-storage at construction
//   - autoRefreshToken: false  — no browser timers / visibilitychange handlers
// so importing/using it during prerender never touches browser-only APIs.
//
// Unlike the browser client, this is created lazily via a function (not a
// top-level singleton) so merely importing this module has zero side effects.
// Reads the same anon-key env vars; anon-key access is the public read path
// (RLS-governed), identical to what the live site uses.
// ============================================================================

import { createClient } from '@supabase/supabase-js'

export function getBuildClient() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'getBuildClient: missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY ' +
      '(required for build-time SSG data fetch).'
    )
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
