// ============================================================================
// kh-admin pure helpers (erasable TS only; node tests import this directly)
// ============================================================================

// "350 Ramapo Valley Rd, Oakland, NJ 07436, USA" →
//   { street: "350 Ramapo Valley Rd", city: "Oakland", state: "NJ", zipcode: "07436" }
// Null when the address can't be split confidently — provisioning refuses
// rather than sending KitchenHub a wrong address.
export function parseUsAddress(
  raw: unknown,
): { street: string; city: string; state: string; zipcode: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^(usa|us|united states( of america)?)$/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length < 3) return null;
  const m = parts[parts.length - 1].match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!m) return null;
  const city = parts[parts.length - 2];
  const street = parts.slice(0, -2).join(", ");
  if (!street || !city) return null;
  return { street, city, state: m[1].toUpperCase(), zipcode: m[2] };
}

// Safe KitchenHub error body: parsed JSON when possible, else text ≤ 2000.
export function safeKhBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}
