// ============================================================================
// Stuck-pending escalation — shared pure helpers
// ============================================================================
//
// Single source of truth for "is this uber_direct order stuck waiting for a
// courier, and how badly?" Used by both the tablet UI (OrdersTab tiles, tab
// badge, detail banner) and the polling hook (useOrderPolling audio decision),
// so the stage definition lives in one place.
//
// Stage definitions (locked spec):
//   0 — not stuck (not uber_direct, not pending, pre-ready, or terminal-but-ours)
//   1 — uber_status='pending' AND now >= pickup_ready_dt              (passive)
//   2 — stage 1 AND now >= pickup_ready_dt + 5 min                    (flash + chime)
//   3 — stage 1 AND now >= pickup_ready_dt + 15 min, OR               (red + chime)
//       uber_status='canceled' AND cancelled_by='uber'  (Uber-initiated cancel,
//       immediate — Uber Direct doesn't emit a 'failed' status, so an Uber
//       cancel is how a failed dispatch surfaces; D6)
//
// pickup_ready_dt is orders.uber_pickup_ready_dt (migration 035).
// ============================================================================

const FIVE_MIN_MS = 5 * 60 * 1000
const FIFTEEN_MIN_MS = 15 * 60 * 1000

export function getStuckStage(order, now = Date.now()) {
  if (!order || order.delivery_fulfillment_method !== 'uber_direct') return 0

  // A resolved order is never stuck. Must precede the Uber-cancel Stage 3
  // check — a refund can leave cancelled_by='uber' on a now-cancelled order,
  // and self_delivering carries uber_status='canceled' too.
  if (['complete', 'cancelled', 'self_delivering'].includes(order.status)) return 0

  // Stage 3 (immediate): Uber initiated the cancellation. Distinct from a
  // restaurant_refund / restaurant_self_deliver cancel (those are ours and
  // are NOT stuck states).
  if (order.uber_status === 'canceled' && order.cancelled_by === 'uber') return 3

  // Time-based stages only apply while still searching (pending).
  if (order.uber_status !== 'pending' || !order.uber_pickup_ready_dt) return 0

  const ready = new Date(order.uber_pickup_ready_dt).getTime()
  if (Number.isNaN(ready) || now < ready) return 0

  const elapsed = now - ready
  if (elapsed >= FIFTEEN_MIN_MS) return 3
  if (elapsed >= FIVE_MIN_MS) return 2
  return 1
}

// Whether a stuck order should be driving the alert (chime + badge). True when
// stage >= 2 and not yet acknowledged.
//
// D4 re-escalation: an ack made during stage 2 must NOT silence stage 3. We
// detect that via the ack timestamp rather than a write-on-transition: for the
// TIME-BASED stage 3, if the ack predates the stage-3 boundary
// (pickup_ready + 15 min) the order is treated as un-acked again so the worse
// alarm re-fires. The Uber-cancel stage 3 is a one-shot (no prior stage 2 to
// escalate from), so a single ack silences it.
export function isStuckUnacked(order, now = Date.now()) {
  const stage = getStuckStage(order, now)
  if (stage < 2) return false
  if (!order.stuck_acknowledged_at) return true

  // Re-fire time-based stage 3 if it was acknowledged while still stage 2.
  if (stage === 3 && order.uber_status === 'pending' && order.uber_pickup_ready_dt) {
    const stage3Boundary = new Date(order.uber_pickup_ready_dt).getTime() + FIFTEEN_MIN_MS
    const ackedAt = new Date(order.stuck_acknowledged_at).getTime()
    if (!Number.isNaN(ackedAt) && ackedAt < stage3Boundary) return true
  }
  return false
}
