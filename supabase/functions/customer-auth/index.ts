// ============================================================================
// customer-auth
// ============================================================================
//
// Purpose
// -------
// Phone-based customer authentication. Customers are NOT Supabase Auth users
// — there is no `supabase.auth.*` call anywhere in this file. We own the
// session tokens: issued here, stored only as a SHA-256 hash, and checked
// here. The plaintext token is handed to the client exactly once (the
// "verify" response) and is never written to the database or logged.
//
// Backing tables (migration 062): customer_identities, customer_sessions,
// restaurant_customers, customer_consents.
//
// Actions (POST, JSON body, dispatched on `action`)
// -------------------------------------------------
//   send    — rate-limit, then ask Twilio Verify to SMS an OTP; record the
//             consent row that is our evidence the customer opted in.
//   verify  — check the OTP with Twilio, upsert the identity, ensure the
//             per-restaurant profile exists, mint a session token.
//   session — exchange a token for the current identity + profile.
//   logout  — revoke a token. Always 200, so a caller cannot probe which
//             tokens are real.
//
// Error discipline
// ----------------
// Twilio response bodies, Postgres errors and stack traces are console.error'd
// and never returned. The client only ever sees a short generic code.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { encode as base64Encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const twilioVerifySid = Deno.env.get("TWILIO_VERIFY_SERVICE_SID") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_CONSENT_TEXT =
  "By continuing you agree to receive a one-time verification code by SMS. " +
  "Message and data rates may apply.";

// Rate-limit windows for the "send" action, all keyed on customer_consents
// rows with kind = 'otp_verification'.
// NOTE: customer_consents doubles as the rate-limit ledger — the counters
// below are derived from its rows, not from separate state. Any future
// retention policy that purges old rows from that table will also reset
// these counters for the phones and IPs it touches.
const COOLDOWN_SECONDS = 60;
const MAX_PER_PHONE_HOUR = 3;
const MAX_PER_PHONE_DAY = 10;
const MAX_PER_IP_HOUR = 10;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Mirrors the normalize_phone_e164() SQL function from migration 062.
// Returns null on anything unparseable — never guess.
// MUST stay in sync with normalize_phone_e164() in migration 062. The two
// are independent implementations of one rule; if they diverge, a phone
// normalized here will not match the same phone normalized in SQL. Any
// change to one requires the identical change to the other.
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return "+1" + digits.slice(1);
  if (digits.length === 10) return "+1" + digits;
  return null;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 32 random bytes, base64url, no padding. This is the only place a plaintext
// token exists server-side; it is returned to the caller and then dropped.
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getClientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const first = forwarded.split(",")[0].trim();
  return first || null;
}

function twilioAuthHeader(): string {
  return (
    "Basic " +
    base64Encode(new TextEncoder().encode(`${twilioSid}:${twilioToken}`))
  );
}

// ---------------------------------------------------------------------------
// Action: send
// ---------------------------------------------------------------------------

async function handleSend(req: Request, body: any): Promise<Response> {
  const phone = normalizePhone(body.phone);
  if (!phone) {
    return jsonResponse({ error: "invalid_phone" }, 400);
  }

  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent");
  const now = Date.now();
  const minuteAgo = new Date(now - COOLDOWN_SECONDS * 1000).toISOString();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // --- Cooldown: one send per phone per COOLDOWN_SECONDS ---
  const { data: lastSend, error: lastErr } = await supabase
    .from("customer_consents")
    .select("created_at")
    .eq("phone_e164", phone)
    .eq("kind", "otp_verification")
    .gte("created_at", minuteAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastErr) {
    console.error("customer-auth send cooldown query failed:", lastErr.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  if (lastSend) {
    const elapsedMs = now - new Date(lastSend.created_at).getTime();
    const remaining = Math.max(
      1,
      Math.ceil((COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000)
    );
    return jsonResponse({ error: "cooldown", retry_after: remaining }, 429);
  }

  // --- Per-phone hourly and daily caps ---
  const { count: phoneHourCount, error: phoneHourErr } = await supabase
    .from("customer_consents")
    .select("id", { count: "exact", head: true })
    .eq("phone_e164", phone)
    .eq("kind", "otp_verification")
    .gte("created_at", hourAgo);

  if (phoneHourErr) {
    console.error(
      "customer-auth send phone/hour query failed:",
      phoneHourErr.message
    );
    return jsonResponse({ error: "server_error" }, 500);
  }
  if ((phoneHourCount ?? 0) >= MAX_PER_PHONE_HOUR) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  const { count: phoneDayCount, error: phoneDayErr } = await supabase
    .from("customer_consents")
    .select("id", { count: "exact", head: true })
    .eq("phone_e164", phone)
    .eq("kind", "otp_verification")
    .gte("created_at", dayAgo);

  if (phoneDayErr) {
    console.error(
      "customer-auth send phone/day query failed:",
      phoneDayErr.message
    );
    return jsonResponse({ error: "server_error" }, 500);
  }
  if ((phoneDayCount ?? 0) >= MAX_PER_PHONE_DAY) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  // --- Per-IP hourly cap. Skipped when the IP is unknown, since a null
  // ip_address would otherwise bucket every anonymous caller together. ---
  if (ip) {
    const { count: ipHourCount, error: ipHourErr } = await supabase
      .from("customer_consents")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", ip)
      .eq("kind", "otp_verification")
      .gte("created_at", hourAgo);

    if (ipHourErr) {
      console.error(
        "customer-auth send ip/hour query failed:",
        ipHourErr.message
      );
      return jsonResponse({ error: "server_error" }, 500);
    }
    if ((ipHourCount ?? 0) >= MAX_PER_IP_HOUR) {
      return jsonResponse({ error: "rate_limited" }, 429);
    }
  }

  // --- Resolve the restaurant purely to validate the id before it is written
  // to customer_consents, so an unknown id stores null rather than tripping the
  // restaurant_id foreign key. We deliberately do NOT pass CustomFriendlyName to
  // Twilio: this account is not permitted to use it (error 60204), and the
  // Verify service friendly name is set to 'restaurant', so the body reads
  // "Your restaurant verification code is: 123456" — intentionally generic,
  // leaking no platform name to the customer. ---
  let resolvedRestaurantId: string | null = null;

  if (body.restaurant_id) {
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .select("id")
      .eq("id", body.restaurant_id)
      .maybeSingle();

    if (restErr) {
      console.error(
        "customer-auth send restaurant lookup failed:",
        restErr.message
      );
    } else if (restaurant) {
      resolvedRestaurantId = restaurant.id;
    }
  }

  // --- Twilio Verify ---
  const form = new URLSearchParams();
  form.set("To", phone);
  form.set("Channel", "sms");

  const twilioRes = await fetch(
    `https://verify.twilio.com/v2/Services/${twilioVerifySid}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  if (!twilioRes.ok) {
    const twilioBody = await twilioRes.text();
    console.error(
      `customer-auth send twilio failed: status=${twilioRes.status} body=${twilioBody}`
    );
    return jsonResponse({ error: "send_failed" }, 502);
  }

  // --- Consent evidence. Written only after Twilio accepted the send, so the
  // rate-limit counters above measure real sends. customer_id stays null —
  // there is no identity yet at this point in the flow. ---
  const { error: consentErr } = await supabase
    .from("customer_consents")
    .insert({
      customer_id: null,
      restaurant_id: resolvedRestaurantId,
      phone_e164: phone,
      kind: "otp_verification",
      text_shown:
        typeof body.consent_text === "string" && body.consent_text.trim()
          ? body.consent_text
          : DEFAULT_CONSENT_TEXT,
      origin: typeof body.origin === "string" ? body.origin : null,
      ip_address: ip,
      user_agent: userAgent,
    });

  // Migration 067 caps one otp_verification row per phone per clock-minute
  // with a partial unique index, closing the race where two concurrent sends
  // both clear the app-level cooldown check above before either inserts. That
  // index is on an expression, so PostgREST's upsert/onConflict — which takes
  // a plain column list — cannot express it; the violation is absorbed here
  // instead.
  //
  // A 23505 at this point is a benign outcome, not a failure: Twilio has
  // already accepted the send, and the row that won the race records the same
  // consent for the same phone in the same minute. Returning 500 would show
  // the customer server_error while their code is already in flight, so this
  // is logged as a debug line and the response stays 200.
  if (consentErr && consentErr.code === "23505") {
    console.debug(
      "customer-auth send consent insert lost cooldown race (benign):",
      consentErr.message
    );
  } else if (consentErr) {
    console.error(
      "customer-auth send consent insert failed:",
      consentErr.message
    );
    return jsonResponse({ error: "server_error" }, 500);
  }

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------------
// Action: verify
// ---------------------------------------------------------------------------

async function handleVerify(req: Request, body: any): Promise<Response> {
  const phone = normalizePhone(body.phone);
  if (!phone) {
    return jsonResponse({ error: "invalid_phone" }, 400);
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return jsonResponse({ error: "invalid_code" }, 400);
  }

  // --- Twilio VerificationCheck. A non-2xx here is the normal Twilio
  // response for an expired or already-consumed verification, so it is
  // logged and reported as invalid_code rather than a server error. ---
  const form = new URLSearchParams();
  form.set("To", phone);
  form.set("Code", code);

  const twilioRes = await fetch(
    `https://verify.twilio.com/v2/Services/${twilioVerifySid}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  if (!twilioRes.ok) {
    const twilioBody = await twilioRes.text();
    console.error(
      `customer-auth verify twilio failed: status=${twilioRes.status} body=${twilioBody}`
    );
    return jsonResponse({ error: "invalid_code" }, 400);
  }

  const twilioJson = await twilioRes.json();
  if (twilioJson.status !== "approved") {
    return jsonResponse({ error: "invalid_code" }, 400);
  }

  // --- Identity. Upsert on the unique phone_e164 so a returning customer
  // keeps their existing id and every downstream row stays attached. ---
  const nowIso = new Date().toISOString();
  const { data: identity, error: identityErr } = await supabase
    .from("customer_identities")
    .upsert(
      { phone_e164: phone, phone_verified_at: nowIso, updated_at: nowIso },
      { onConflict: "phone_e164" }
    )
    .select("id, phone_e164")
    .single();

  if (identityErr || !identity) {
    console.error(
      "customer-auth verify identity upsert failed:",
      identityErr?.message
    );
    return jsonResponse({ error: "server_error" }, 500);
  }

  // --- Guest loyalty claim. Points accrue to a normalized phone number with
  // a null customer_id while the customer is a guest. On first verification
  // we attach those ledger rows to this identity, rebuild the per-restaurant
  // balances from the ledger, and backfill orders.customer_id. This must run
  // before the profile upsert below: the claim creates profile rows for every
  // restaurant the phone has points at, and the profile read that follows has
  // to see the claimed balance. A failure here is logged but never fails the
  // verification — the claim is idempotent and can be re-run. ---
  const { error: claimErr } = await supabase.rpc("claim_guest_loyalty", {
    p_customer_id: identity.id,
  });

  if (claimErr) {
    console.error(
      "customer-auth verify guest loyalty claim failed:",
      claimErr.message
    );
  }

  // --- Per-restaurant profile. ignoreDuplicates makes this INSERT ... ON
  // CONFLICT DO NOTHING, so an existing profile's points, tier, name and
  // email are left untouched. A bad restaurant_id fails the foreign key;
  // that is logged and the profile comes back null rather than failing a
  // verification that already succeeded. ---
  let profile: Record<string, unknown> | null = null;

  if (body.restaurant_id) {
    const { error: profileUpsertErr } = await supabase
      .from("restaurant_customers")
      .upsert(
        { restaurant_id: body.restaurant_id, customer_id: identity.id },
        { onConflict: "restaurant_id,customer_id", ignoreDuplicates: true }
      );

    if (profileUpsertErr) {
      console.error(
        "customer-auth verify profile upsert failed:",
        profileUpsertErr.message
      );
    } else {
      // restaurant_customers.tier was dropped by migration 063 in favour of
      // tier_level; lifetime_points_earned drives tier progress and
      // order_count the greeting subline on the customer rewards page.
      const { data: profileRow, error: profileErr } = await supabase
        .from("restaurant_customers")
        .select("display_name, email, points_balance, tier_level, lifetime_points_earned, order_count")
        .eq("restaurant_id", body.restaurant_id)
        .eq("customer_id", identity.id)
        .maybeSingle();

      if (profileErr) {
        console.error(
          "customer-auth verify profile read failed:",
          profileErr.message
        );
      } else {
        profile = profileRow;
      }
    }
  }

  // --- Session. Only the hash is stored; expires_at comes from the column
  // default set in migration 062. ---
  const token = newToken();
  const tokenHash = await hashToken(token);

  const { error: sessionErr } = await supabase.from("customer_sessions").insert({
    customer_id: identity.id,
    token_hash: tokenHash,
    origin: typeof body.origin === "string" ? body.origin : null,
    surface: typeof body.surface === "string" && body.surface ? body.surface : "web",
    user_agent: req.headers.get("user-agent"),
  });

  if (sessionErr) {
    console.error(
      "customer-auth verify session insert failed:",
      sessionErr.message
    );
    return jsonResponse({ error: "server_error" }, 500);
  }

  return jsonResponse(
    { ok: true, token, customer_id: identity.id, profile },
    200
  );
}

// ---------------------------------------------------------------------------
// Action: session
// ---------------------------------------------------------------------------

async function handleSession(body: any): Promise<Response> {
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const tokenHash = await hashToken(token);

  const { data: session, error: sessionErr } = await supabase
    .from("customer_sessions")
    .select("id, customer_id, revoked_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (sessionErr) {
    console.error("customer-auth session lookup failed:", sessionErr.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  // Missing, revoked and expired all collapse to the same response so a
  // caller cannot tell them apart.
  if (
    !session ||
    session.revoked_at !== null ||
    new Date(session.expires_at).getTime() < Date.now()
  ) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const { error: touchErr } = await supabase
    .from("customer_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id);

  if (touchErr) {
    // Non-fatal: the session is valid, we just failed to record the touch.
    console.error("customer-auth session touch failed:", touchErr.message);
  }

  const { data: identity, error: identityErr } = await supabase
    .from("customer_identities")
    .select("id, phone_e164")
    .eq("id", session.customer_id)
    .maybeSingle();

  if (identityErr || !identity) {
    console.error(
      "customer-auth session identity read failed:",
      identityErr?.message
    );
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  let profile: Record<string, unknown> | null = null;

  if (body.restaurant_id) {
    // restaurant_customers.tier was dropped by migration 063 in favour of
    // tier_level; lifetime_points_earned drives tier progress and order_count
    // the greeting subline on the customer rewards page.
    const { data: profileRow, error: profileErr } = await supabase
      .from("restaurant_customers")
      .select("display_name, email, points_balance, tier_level, lifetime_points_earned, order_count")
      .eq("restaurant_id", body.restaurant_id)
      .eq("customer_id", identity.id)
      .maybeSingle();

    if (profileErr) {
      console.error(
        "customer-auth session profile read failed:",
        profileErr.message
      );
    } else {
      profile = profileRow;
    }
  }

  return jsonResponse(
    {
      ok: true,
      customer_id: identity.id,
      phone_e164: identity.phone_e164,
      profile,
    },
    200
  );
}

// ---------------------------------------------------------------------------
// Action: logout
// ---------------------------------------------------------------------------

async function handleLogout(body: any): Promise<Response> {
  const token = typeof body.token === "string" ? body.token : "";

  if (token) {
    const tokenHash = await hashToken(token);
    const { error: revokeErr } = await supabase
      .from("customer_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", tokenHash)
      .is("revoked_at", null);

    if (revokeErr) {
      console.error("customer-auth logout revoke failed:", revokeErr.message);
    }
  }

  // Always ok, matched or not — never leak whether a token was valid.
  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------------
// Action: history
// ---------------------------------------------------------------------------

async function handleHistory(body: any): Promise<Response> {
  // Token resolution is duplicated from handleSession rather than extracted.
  // Folding both onto a shared helper touches a working auth path, which is a
  // separate change from adding a read-only action.
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  if (typeof body.restaurant_id !== "string") {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  const tokenHash = await hashToken(token);

  const { data: session, error: sessionErr } = await supabase
    .from("customer_sessions")
    .select("id, customer_id, revoked_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (sessionErr) {
    console.error("customer-auth history session lookup failed:", sessionErr.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  // Missing, revoked and expired all collapse to the same response so a
  // caller cannot tell them apart.
  if (
    !session ||
    session.revoked_at !== null ||
    new Date(session.expires_at).getTime() < Date.now()
  ) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const { data: identity, error: identityErr } = await supabase
    .from("customer_identities")
    .select("id, phone_e164")
    .eq("id", session.customer_id)
    .maybeSingle();

  if (identityErr || !identity) {
    console.error(
      "customer-auth history identity read failed:",
      identityErr?.message
    );
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  // This function runs service-role, so RLS is not a backstop here: both the
  // customer and the restaurant filter are what scope these reads. Neither is
  // optional.
  //
  // base_price and price_charged are deliberately absent from the item and
  // topping selects — a reorder has to reprice against today's menu, and
  // shipping the historical price to the client invites using it.
  const { data: orders, error: ordersErr } = await supabase
    .from("orders")
    .select(
      "id, created_at, order_type, total_amount, status, order_items(id, menu_item_id, item_size_id, item_name, size_name, quantity, special_instructions, order_item_toppings(topping_id, topping_name, placement, placement_type))"
    )
    .eq("customer_id", identity.id)
    .eq("restaurant_id", body.restaurant_id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (ordersErr) {
    console.error("customer-auth history orders read failed:", ordersErr.message);
  }

  const { data: transactions, error: txErr } = await supabase
    .from("loyalty_transactions")
    .select("id, created_at, reason, points_delta, order_id")
    .eq("customer_id", identity.id)
    .eq("restaurant_id", body.restaurant_id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (txErr) {
    console.error("customer-auth history transactions read failed:", txErr.message);
  }

  // Either side failing degrades to an empty list rather than failing the
  // request — a partial history beats a broken page.
  return jsonResponse(
    {
      ok: true,
      orders: orders ?? [],
      transactions: transactions ?? [],
    },
    200
  );
}

// ---------------------------------------------------------------------------
// Action: profile
// ---------------------------------------------------------------------------

// Saved contact + address on the identity. Every column here is written ONLY
// from a resolved session — the order path resolves customers by phone string
// equality and cannot tell a verified customer from a guest who typed the
// same number, so it must never reach these fields (see migration 076).
const PROFILE_COLUMNS =
  "id, phone_e164, email, display_name, delivery_address, delivery_apt, delivery_lat, delivery_lng";

const PROFILE_STRING_FIELDS = [
  "email",
  "display_name",
  "delivery_address",
  "delivery_apt",
];

const PROFILE_NUMBER_FIELDS = ["delivery_lat", "delivery_lng"];

// Touching any of these stamps address_updated_at.
const PROFILE_ADDRESS_FIELDS = [
  "delivery_address",
  "delivery_apt",
  "delivery_lat",
  "delivery_lng",
];

function profileShape(row: any) {
  return {
    phone_e164: row.phone_e164,
    email: row.email,
    display_name: row.display_name,
    delivery_address: row.delivery_address,
    delivery_apt: row.delivery_apt,
    delivery_lat: row.delivery_lat,
    delivery_lng: row.delivery_lng,
  };
}

async function handleProfile(body: any): Promise<Response> {
  // Token resolution is duplicated from handleHistory rather than extracted,
  // for the same reason: folding these onto a shared helper touches a working
  // auth path, which is a separate change from adding an action.
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const tokenHash = await hashToken(token);

  const { data: session, error: sessionErr } = await supabase
    .from("customer_sessions")
    .select("id, customer_id, revoked_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (sessionErr) {
    console.error("customer-auth profile session lookup failed:", sessionErr.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  // Missing, revoked and expired all collapse to the same response so a
  // caller cannot tell them apart.
  if (
    !session ||
    session.revoked_at !== null ||
    new Date(session.expires_at).getTime() < Date.now()
  ) {
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const { data: identity, error: identityErr } = await supabase
    .from("customer_identities")
    .select(PROFILE_COLUMNS)
    .eq("id", session.customer_id)
    .maybeSingle();

  if (identityErr || !identity) {
    console.error(
      "customer-auth profile identity read failed:",
      identityErr?.message
    );
    return jsonResponse({ error: "invalid_session" }, 401);
  }

  const updates = body.updates;

  // No updates key at all → read.
  if (updates === undefined || updates === null) {
    return jsonResponse({ ok: true, profile: profileShape(identity) }, 200);
  }

  // Present but not a plain object is a malformed write, not a read.
  if (typeof updates !== "object" || Array.isArray(updates)) {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  // Only the whitelisted keys are read; anything else in the object is
  // ignored. A key present as '' or null clears that field — a customer
  // removing their saved address is a legitimate write.
  const payload: Record<string, unknown> = {};

  for (const key of PROFILE_STRING_FIELDS) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (value === null) {
      payload[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    payload[key] = value.trim();
  }

  for (const key of PROFILE_NUMBER_FIELDS) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (value === null) {
      payload[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    payload[key] = value;
  }

  const nowIso = new Date().toISOString();
  if (PROFILE_ADDRESS_FIELDS.some((key) => key in payload)) {
    payload.address_updated_at = nowIso;
  }
  payload.updated_at = nowIso;

  // By id, never by phone: the id came from the session, the phone did not.
  const { data: updated, error: updateErr } = await supabase
    .from("customer_identities")
    .update(payload)
    .eq("id", identity.id)
    .select(PROFILE_COLUMNS)
    .single();

  if (updateErr || !updated) {
    console.error("customer-auth profile update failed:", updateErr?.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  return jsonResponse({ ok: true, profile: profileShape(updated) }, 200);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid_body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid_body" }, 400);
    }

    switch (body.action) {
      case "send":
        return await handleSend(req, body);
      case "verify":
        return await handleVerify(req, body);
      case "session":
        return await handleSession(body);
      case "history":
        return await handleHistory(body);
      case "profile":
        return await handleProfile(body);
      case "logout":
        return await handleLogout(body);
      default:
        return jsonResponse({ error: "unknown_action" }, 400);
    }
  } catch (err: any) {
    console.error("customer-auth error:", err?.message, err?.stack);
    return jsonResponse({ error: "server_error" }, 500);
  }
});
