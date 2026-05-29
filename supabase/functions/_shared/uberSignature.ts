// ============================================================================
// Uber Direct webhook signature verification — pure crypto library
// ============================================================================
//
// Single source of truth for verifying Uber Direct webhook signatures.
// Used by:
//   - supabase/functions/uber-webhook/index.ts (M9b webhook handler)
//
// Algorithm:
//   1. Uber signs each webhook POST with HMAC-SHA256 of the raw request
//      body, using the merchant's uber_webhook_signing_secret as the key.
//   2. The signature is sent as lowercase hex in the X-Uber-Signature
//      header (or X-Postmates-Signature for legacy delivery_status /
//      courier_update events).
//   3. To verify: recompute HMAC-SHA256 of the EXACT raw bytes received
//      and constant-time-compare to the header value.
//
// Critical implementation notes:
//   - rawBody MUST be the exact bytes received (await req.text(), not
//     req.json() which can normalize whitespace/escapes and break the
//     signature).
//   - Comparison is constant-time to prevent timing attacks; a naive ===
//     would short-circuit on first mismatch and leak how much of the
//     signature was correct.
//   - Header value is normalized to lowercase before comparison
//     (defensive — Uber's docs say lowercase but mid-flight proxies
//     could theoretically uppercase it).
//   - Malformed hex in the header (non-hex chars, wrong length) returns
//     false without throwing.
//
// Uses Deno WebCrypto (crypto.subtle) — no Node crypto module needed.
// ============================================================================

// HMAC-SHA256 always produces 32 bytes = 64 lowercase hex chars. Anything
// else in the header is automatic reject.
const EXPECTED_HEX_LENGTH = 64;
const HEX_REGEX = /^[0-9a-f]+$/;

// Lowercase hex HMAC-SHA256 of payload, keyed with secret.
// Returns 64-character lowercase hex string.
export async function computeHmacSha256Hex(
  secret: string,
  payload: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string comparison. Returns true iff strings are equal
// AND have the same length. Iterates ALL characters regardless of
// mismatch position; XOR accumulator detects any difference. Prevents
// the timing attack where naive === would short-circuit on first
// mismatch and leak how many leading characters were correct.
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Top-level verification: returns true iff signatureHeader matches
// HMAC-SHA256(signingSecret, rawBody). Returns false defensively for
// any malformed input (null/empty header, bad hex, wrong length,
// unexpected exception from crypto.subtle).
export async function verifyUberSignature(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string
): Promise<boolean> {
  if (!signatureHeader || !signingSecret) return false;
  const normalized = signatureHeader.trim().toLowerCase();
  if (normalized.length !== EXPECTED_HEX_LENGTH) return false;
  if (!HEX_REGEX.test(normalized)) return false;
  try {
    const expected = await computeHmacSha256Hex(signingSecret, rawBody);
    return timingSafeStringEqual(expected, normalized);
  } catch (err) {
    // crypto.subtle is generally infallible for valid inputs; this
    // branch protects against unexpected runtime errors (e.g., Deno
    // version regression) by returning false rather than throwing.
    console.error("[uberSignature] verify failed unexpectedly", err);
    return false;
  }
}
