import { supabase } from '../lib/supabase'

// Durable print-status write for a DSP order. Same 3-try / 300ms retry as
// autoPrint's orders write. .select('id') so an RLS zero-row update counts as
// a failure instead of a silent success. Never throws.
export async function writeExternalPrintResult(id, result, attempt) {
  const update = result.success
    ? { print_status: 'printed', print_attempts: attempt, printed_at: new Date().toISOString(), last_print_error: null }
    : { print_status: 'failed', print_attempts: attempt, last_print_error: result.message || 'unknown error' }
  let lastErr = null
  for (let w = 0; w < 3; w++) {
    try {
      const { data, error } = await supabase.from('external_orders').update(update).eq('id', id).select('id')
      if (!error && data && data.length > 0) return true
      lastErr = error || 'no rows updated'
    } catch (err) {
      lastErr = err
    }
    if (w < 2) await new Promise(r => setTimeout(r, 300))
  }
  console.error('[ExtPrint] print_status write failed after retries', id, lastErr)
  return false
}
