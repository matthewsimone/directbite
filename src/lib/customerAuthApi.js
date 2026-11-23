// Customers have no Supabase session, so every call authenticates with the
// anon key alone — sent as both `apikey` and `Authorization`, matching
// ConfirmationPage's get-order-by-pi call. Never throws on a non-2xx; the
// caller branches on `ok` and reads the error out of `data`.
export async function callCustomerAuth(body, signal) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const res = await fetch(`${supabaseUrl}/functions/v1/customer-auth`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
