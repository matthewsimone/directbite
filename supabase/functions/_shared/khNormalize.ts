// ============================================================================
// KitchenHub order normalization — pure functions, no Deno/Supabase imports
// ============================================================================
//
// Used by:
//   - supabase/functions/kh-webhook/index.ts
//   - supabase/functions/_shared/khNormalize.test.mjs (plain `node`)
//
// Only erasable TypeScript syntax (type annotations, no enums/namespaces) so
// Node's built-in type stripping can import this file directly in tests.
//
// Webhook v2 shape:
//   { version, event_data: { event_type, status },
//     order: { order, provider, store, customer, items, delivery, payment,
//              charges, timestamps, location } }
// ============================================================================

export type OrderStatus = "new" | "accepted" | "completed" | "cancelled";

const STATUS_RANK: Record<string, number> = {
  new: 0,
  accepted: 1,
  completed: 2,
};

// Map KitchenHub's raw order.status to our status vocabulary. Anything we
// don't recognize returns null so the caller keeps the existing status.
export function normalizeStatus(raw: unknown): OrderStatus | null {
  switch (raw) {
    case "new":
      return "new";
    case "accepted":
      return "accepted";
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

// Forward-only status resolution for out-of-order webhook deliveries.
// 'cancelled' is terminal and always wins; otherwise never move to a lower
// rank (a late 'accepted' must not downgrade 'completed').
export function resolveStatus(
  existing: string | null | undefined,
  incoming: OrderStatus | null,
): string {
  if (existing === "cancelled") return "cancelled";
  if (incoming === "cancelled") return "cancelled";
  if (incoming == null) return existing ?? "new";
  if (existing == null) return incoming;
  const existingRank = STATUS_RANK[existing];
  // Unknown existing value: accept the recognized incoming status.
  if (existingRank === undefined) return incoming;
  return STATUS_RANK[incoming] >= existingRank ? incoming : existing;
}

// Return the order envelope ({ order, provider, store, ... }) from either the
// v2 webhook shape or a flat shape where the envelope's `order` is the bare
// order object. Null when neither shape matches.
// deno-lint-ignore no-explicit-any
export function extractOrder(payload: any): any | null {
  if (payload?.order?.order) return payload.order;
  if (payload?.order?.id != null) return payload;
  return null;
}

export function isSafeOrderId(id: unknown): boolean {
  return Number.isSafeInteger(id) && (id as number) > 0;
}

// Accept a KitchenHub order id as a number or an all-digit string. Returns
// the safe positive integer, or null for anything else (including digit
// strings beyond Number.MAX_SAFE_INTEGER).
export function parseOrderId(id: unknown): number | null {
  if (typeof id === "number") return isSafeOrderId(id) ? id : null;
  if (typeof id === "string" && /^\d+$/.test(id)) {
    const n = Number(id);
    return isSafeOrderId(n) ? n : null;
  }
  return null;
}

// Charges total may arrive as a number or numeric string. Number(null) and
// Number("") are 0, so treat null/empty explicitly as missing.
function toTotal(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map an extracted envelope to external_orders columns. Deliberately omits
// restaurant_id, status, and every tablet-owned column (acknowledged_at,
// print_status, print_attempts, printed_at, last_print_error) plus
// created_at, so an upsert never overwrites them. Never throws.
// deno-lint-ignore no-explicit-any
export function toRow(o: any): Record<string, unknown> {
  const order = o?.order;
  const ts = o?.timestamps;
  const customer = o?.customer;
  return {
    kh_order_id: order?.id ?? null,
    kh_store_id: o?.store?.id ?? null,
    provider_id: o?.provider?.id ?? null,
    provider_name: o?.provider?.name ?? null,
    external_id: order?.external_id ?? null,
    order_number: order?.number ?? null,
    daily_number: order?.daily_number ?? null,
    order_type: order?.type ?? null,
    kh_status_raw: order?.status ?? null,
    asap: order?.asap ?? null,
    notes: order?.notes ?? null,
    prep_time_minutes: order?.prep_time_minutes ?? null,
    cancelled_by: order?.cancelled_by ?? null,
    scheduled_for: order?.asap === false ? (ts?.scheduled_for ?? null) : null,
    pickup_at: ts?.pickup_at ?? null,
    placed_at: ts?.placed_at ?? null,
    accepted_at: ts?.accepted_at ?? null,
    completed_at: ts?.completed_at ?? null,
    cancelled_at: ts?.cancelled_at ?? null,
    customer_name: customer?.name ?? null,
    customer_phone: customer?.phone_number ?? null,
    customer_phone_code: customer?.phone_code ?? null,
    delivery_type: o?.delivery?.type ?? null,
    delivery: o?.delivery ?? null,
    items: o?.items ?? [],
    charges: o?.charges ?? null,
    total: toTotal(o?.charges?.total),
    payment_method: o?.payment?.method ?? null,
  };
}
