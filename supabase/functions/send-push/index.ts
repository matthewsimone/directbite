// ============================================================================
// send-push
// ============================================================================
//
// Purpose
// -------
// Admin-only test sender for native app push (Phase 3). Sends one notification
// to every active device token registered for a restaurant's app. The tablet
// sender will reuse this core later.
//
// Auth: header x-admin-key must equal the PUSH_ADMIN_KEY secret (constant-time
// compare). No JWT (verify_jwt = false in config.toml).
//
// Body: { slug, title, body, dry_run? }
//   title 1–65 chars, body 1–240 chars. dry_run sends with validate_only, so
//   FCM checks every token and payload without delivering anything.
//
// FCM HTTP v1. The OAuth access token is minted here from the FCM_SERVICE_ACCOUNT
// secret (the service-account JSON) with an RS256 JWT signed by Web Crypto —
// no SDK, no new dependencies.
//
// Dead tokens (404, UNREGISTERED, or INVALID_ARGUMENT about the token) are
// marked disabled_at = now with a short last_error code. register_push clears
// both when the device registers again.
//
// Error discipline: push tokens are never logged in full (last 6 chars at
// most). FCM and Postgres error bodies are console.error'd, never returned.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Last 6 characters only — enough to correlate a log line with a row,
// not enough to address a device.
function tokenTail(token: string): string {
  return "…" + token.slice(-6);
}

// Constant-time comparison. Both sides are hashed first so the loop always
// runs over 32 bytes, whatever the input lengths.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// OAuth: service-account JWT -> access token
// ---------------------------------------------------------------------------

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function readServiceAccount(): ServiceAccount | null {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (
      typeof sa?.project_id === "string" &&
      typeof sa?.client_email === "string" &&
      typeof sa?.private_key === "string"
    ) {
      return sa as ServiceAccount;
    }
  } catch {
    // fall through
  }
  return null;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const signingInput =
    base64UrlFromString(JSON.stringify(header)) + "." +
    base64UrlFromString(JSON.stringify(claims));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const jwt = signingInput + "." + base64UrlFromBytes(new Uint8Array(signature));

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.access_token !== "string") {
    throw new Error(`oauth exchange failed: ${res.status} ${data?.error ?? ""}`);
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// FCM send
// ---------------------------------------------------------------------------

type SendOutcome =
  | { kind: "sent" }
  | { kind: "dead"; code: string }
  | { kind: "failed" };

// Classifies an FCM error response. Dead = the token will never work again.
function deadTokenCode(status: number, err: any): string | null {
  if (status === 404) return "NOT_FOUND";

  const details: any[] = Array.isArray(err?.details) ? err.details : [];
  const fcmCodes = details
    .map((d) => (typeof d?.errorCode === "string" ? d.errorCode : null))
    .filter(Boolean) as string[];

  if (fcmCodes.includes("UNREGISTERED") || err?.status === "UNREGISTERED") {
    return "UNREGISTERED";
  }

  // INVALID_ARGUMENT is also returned for a bad payload, which is not the
  // token's fault. Only treat it as dead when FCM says it is about the token.
  const isInvalidArg =
    err?.status === "INVALID_ARGUMENT" || fcmCodes.includes("INVALID_ARGUMENT");
  const aboutToken =
    /registration token/i.test(String(err?.message ?? "")) ||
    details.some((d) =>
      Array.isArray(d?.fieldViolations) &&
      d.fieldViolations.some((v: any) => /token/i.test(String(v?.field ?? "")))
    );
  if (isInvalidArg && aboutToken) return "INVALID_TOKEN";

  return null;
}

async function sendOne(
  accessToken: string,
  projectId: string,
  token: string,
  payload: { title: string; body: string; slug: string; dryRun: boolean }
): Promise<SendOutcome> {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          validate_only: payload.dryRun,
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: { slug: payload.slug },
            android: { priority: "high" },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      }
    );

    if (res.ok) return { kind: "sent" };

    const data = await res.json().catch(() => ({}));
    const err = data?.error ?? {};
    const code = deadTokenCode(res.status, err);
    console.error(
      "send-push fcm error:",
      tokenTail(token),
      res.status,
      err?.status ?? "",
      code ?? ""
    );
    return code ? { kind: "dead", code } : { kind: "failed" };
  } catch (e: any) {
    console.error("send-push fcm request failed:", tokenTail(token), e?.message);
    return { kind: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    // --- Auth ---
    const adminKey = Deno.env.get("PUSH_ADMIN_KEY");
    if (!adminKey) {
      return jsonResponse({ ok: false, error: "not_configured" }, 500);
    }
    const provided = req.headers.get("x-admin-key") ?? "";
    if (!(await safeEqual(provided, adminKey))) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    // --- Body ---
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid_body" }, 400);
    }

    const slug = typeof body?.slug === "string" ? body.slug : "";
    const title = typeof body?.title === "string" ? body.title : "";
    const text = typeof body?.body === "string" ? body.body : "";
    const dryRun = !!body?.dry_run;

    if (
      !slug ||
      title.trim().length < 1 || title.length > 65 ||
      text.trim().length < 1 || text.length > 240
    ) {
      return jsonResponse({ ok: false, error: "invalid_request" }, 400);
    }

    // --- Restaurant ---
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (restErr) {
      console.error("send-push restaurant read failed:", restErr.message);
      return jsonResponse({ ok: false, error: "server_error" }, 500);
    }
    if (!restaurant?.id) {
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    }

    // --- Tokens ---
    const { data: rows, error: tokErr } = await supabase
      .from("push_tokens")
      .select("id, token")
      .eq("restaurant_id", restaurant.id)
      .is("disabled_at", null);

    if (tokErr) {
      console.error("send-push token read failed:", tokErr.message);
      return jsonResponse({ ok: false, error: "server_error" }, 500);
    }

    const tokens = rows ?? [];
    if (tokens.length === 0) {
      return jsonResponse({ ok: true, total: 0, sent: 0, failed: 0, disabled: 0 }, 200);
    }

    // --- OAuth ---
    const sa = readServiceAccount();
    if (!sa) {
      return jsonResponse({ ok: false, error: "not_configured" }, 500);
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(sa);
    } catch (e: any) {
      console.error("send-push oauth failed:", e?.message);
      return jsonResponse({ ok: false, error: "fcm_auth_failed" }, 502);
    }

    // --- Send, CONCURRENCY at a time ---
    let sent = 0;
    let failed = 0;
    let disabled = 0;
    const payload = { title, body: text, slug, dryRun };

    let next = 0;
    async function worker() {
      while (next < tokens.length) {
        const row = tokens[next++];
        const outcome = await sendOne(accessToken, sa!.project_id, row.token, payload);

        if (outcome.kind === "sent") {
          sent++;
          continue;
        }

        failed++;
        if (outcome.kind === "dead") {
          const { error: disErr } = await supabase
            .from("push_tokens")
            .update({
              disabled_at: new Date().toISOString(),
              last_error: outcome.code,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);

          if (disErr) {
            console.error("send-push disable failed:", tokenTail(row.token), disErr.message);
          } else {
            disabled++;
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tokens.length) }, () => worker())
    );

    return jsonResponse(
      { ok: true, total: tokens.length, sent, failed, disabled },
      200
    );
  } catch (err: any) {
    console.error("send-push error:", err?.message);
    return jsonResponse({ ok: false, error: "server_error" }, 500);
  }
});
