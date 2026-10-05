// ============================================================================
// KitchenHub API auth — cached client-credentials token + authed fetch
// ============================================================================
//
// One access token is shared by every function through
// public.kitchenhub_tokens (single row id = 1, service-role only). A cached
// token is reused while it has more than 60s left; otherwise we POST
// /v2/auth/token/ with KITCHENHUB_CLIENT_ID / KITCHENHUB_CLIENT_SECRET and
// store the new one. Expiry is recorded as now + 25 min regardless of the
// returned access_token_expire — we don't trust its unit. The refresh_token is
// not used: re-authenticating with client credentials is always valid.
//
// Never logs token values.
// ============================================================================

const KH_BASE = "https://api.kitchenhub.app";
const TOKEN_TTL_MS = 25 * 60 * 1000;
const REUSE_MARGIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export class KhAuthError extends Error {
  http: number | null;
  constructor(message: string, http: number | null = null) {
    super(message);
    this.http = http;
  }
}

// deno-lint-ignore no-explicit-any
type Db = any;

export async function getKhToken(
  supabase: Db,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (!opts.force) {
    const { data, error } = await supabase
      .from("kitchenhub_tokens")
      .select("access_token, access_expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (error) console.error("[khToken] cache read failed", { error: error.message });
    if (
      data?.access_token &&
      data.access_expires_at &&
      new Date(data.access_expires_at).getTime() > Date.now() + REUSE_MARGIN_MS
    ) {
      return data.access_token;
    }
  }

  const clientId = Deno.env.get("KITCHENHUB_CLIENT_ID");
  const clientSecret = Deno.env.get("KITCHENHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new KhAuthError("credentials_not_configured");

  const res = await fetch(`${KH_BASE}/v2/auth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error("[khToken] token request failed", { http: res.status });
    await res.body?.cancel();
    throw new KhAuthError("token_request_failed", res.status);
  }
  const json = await res.json().catch(() => null);
  const token = json?.access_token;
  if (typeof token !== "string" || !token) {
    throw new KhAuthError("token_missing_in_response", res.status);
  }

  const nowMs = Date.now();
  const { error: upErr } = await supabase.from("kitchenhub_tokens").upsert({
    id: 1,
    access_token: token,
    access_expires_at: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  });
  // A failed cache write still leaves a usable token for this request.
  if (upErr) console.error("[khToken] cache write failed", { error: upErr.message });
  return token;
}

// fetch() against the KitchenHub API with the cached Bearer token. On a 401
// the token is force-refreshed and the request retried exactly once. `init`
// bodies must be re-sendable (strings), which every caller here uses.
export async function khFetch(
  supabase: Db,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${KH_BASE}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
  let res = await send(await getKhToken(supabase));
  if (res.status === 401) {
    await res.body?.cancel();
    console.warn("[khToken] 401 from KitchenHub; refreshing token and retrying once", { path });
    res = await send(await getKhToken(supabase, { force: true }));
  }
  return res;
}
