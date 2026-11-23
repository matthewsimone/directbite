/**
 * pos-v1-staff-snapshot + pos-v1-submit-staff-events (SYNC-CONTRACT §3b, §3a entity rules, §1a).
 * Reference: ordr-pos test/support/fakeServer.ts invoke :202-210, doGetStaffSnapshot :496-501,
 * doSubmitStaffEvent :503-513, entity() :571-600, entityOk :602-604.
 */
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { entityIdentity, restaurantIdentity } from '../pos-device/identity.ts';
import { CanonicalJsonError, contentHash, ORDER_HASH_EXCLUDES } from '../pos-sync/canonicalJson.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { jsonDepth, MAX_DEPTH, UUID_RE } from '../pos-sync/orderPayload.ts';
import { findCardNumbers } from '../ordr-core-ext/cardData.ts';
import { knownActor } from './flags.ts';
import { buildStaffSnapshot, StaffConfigError, type StaffSnapshot } from './snapshot.ts';
import type { StaffStore } from './store.ts';

export interface StaffDeps extends AuthDeps {
  staff: StaffStore;
}

/**
 * The restaurant's current staff snapshot, published (persisted) before it is returned. Reads the latest
 * published version FIRST, then the source (versions only grow, so the source is never older): equal →
 * the stored one; newer → build, persist, return. null = no staff configured. Used by the function and
 * by scripts/pos-staff.ts right after every change (so published_at ≈ the change time).
 */
export async function currentStaffSnapshot(store: StaffStore, restaurantId: string, nowMs: number): Promise<Omit<StaffSnapshot, 'server_time'> | null> {
  const latest = await store.latestPublished(restaurantId);
  const src = await store.source(restaurantId);
  if (!src) return null;
  if (latest && latest.version === src.version) return latest.body;
  const snap = await buildStaffSnapshot(restaurantId, src);
  await store.publish(restaurantId, snap, nowMs);
  return snap;
}

// ---- pos-v1-staff-snapshot -------------------------------------------------------------------------

export async function handleStaffSnapshot(req: DeviceRequest, deps: StaffDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const bad = restaurantIdentity(body, a.principal);
  if (bad) return bad;
  const ifNoneMatch = body.if_none_match ?? null;
  if (ifNoneMatch !== null && typeof ifNoneMatch !== 'string') return errorResult(400, 'invalid_payload', 'if_none_match must be a string or null', { field: 'if_none_match' });
  const nowMs = deps.now();
  let snap: Omit<StaffSnapshot, 'server_time'> | null;
  try {
    snap = await currentStaffSnapshot(deps.staff, a.principal.restaurant_id, nowMs);
  } catch (err) {
    if (err instanceof StaffConfigError) {
      deps.log('staff_snapshot_failed', { restaurant_id: a.principal.restaurant_id, field: err.field });
      return errorResult(500, 'staff_config_invalid', err.message, { field: err.field });
    }
    throw err;
  }
  if (!snap) return errorResult(404, 'no_staff', 'no staff configured');
  if (ifNoneMatch === snap.hash) return okResult({ not_modified: true, hash: snap.hash });
  return okResult({ ...snap, server_time: new Date(nowMs).toISOString() });
}

// ---- pos-v1-submit-staff-events ------------------------------------------------------------------

export const STAFF_EVENT_TYPES = ['sign_in', 'lock', 'pin_failed', 'staff_locked', 'staff_unlocked', 'approval_granted', 'approval_denied', 'drawer_kick'] as const;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

function eventProblem(p: Record<string, unknown>): { field: string; message: string } | null {
  if (p.version !== 1) return { field: 'version', message: 'version must be 1' };
  if (!(STAFF_EVENT_TYPES as readonly unknown[]).includes(p.type)) return { field: 'type', message: `type must be one of ${STAFF_EVENT_TYPES.join(' | ')}` };
  for (const k of ['staff_id', 'by_staff_id', 'purpose', 'target_id']) {
    if (!(k in p) || (p[k] !== null && typeof p[k] !== 'string')) return { field: k, message: `${k} must be a string or null` };
  }
  for (const k of ['created_at', 'device_time']) if (!isIso(p[k])) return { field: k, message: `${k} must be ISO-8601` };
  return null;
}

export async function handleStaffEvent(req: DeviceRequest, deps: StaffDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const pr = a.principal;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const p = parsed.value;
  if (jsonDepth(p) > MAX_DEPTH) return errorResult(400, 'invalid_payload', `nesting deeper than ${MAX_DEPTH}`);
  if (typeof p.event_id !== 'string' || !UUID_RE.test(p.event_id)) return errorResult(400, 'invalid_payload', 'event_id must be a UUID', { field: 'event_id' });
  const existing = await deps.staff.getEvent(p.event_id);
  // §1a entity identity (an existing event of another restaurant → 400)
  const idBad = entityIdentity(p, pr, existing?.restaurant_id ?? null);
  if (idBad) return idBad;
  // §3a: content hash, card guard, idempotency
  let recomputed: string;
  try {
    recomputed = await contentHash(p, ORDER_HASH_EXCLUDES);
  } catch (err) {
    if (err instanceof CanonicalJsonError) return errorResult(400, 'invalid_payload', `not canonical JSON: ${err.message}`);
    throw err;
  }
  if (recomputed !== p.content_hash) return errorResult(400, 'invalid_payload', 'content_hash does not match', { field: 'content_hash' });
  const card = findCardNumbers(p);
  if (card.length) return errorResult(400, 'card_data_rejected', `card-number-like text at ${card.join(', ')}`, { field: card[0] });
  const shape = eventProblem(p);
  if (shape) return errorResult(400, 'invalid_payload', shape.message, { field: shape.field });

  const reuse = () => errorResult(409, 'idempotency_key_reuse', `staff_event:${p.event_id}:1 was already applied with different content`);
  if (existing) return existing.content_hash === p.content_hash ? okResult({ ...existing.response, result: 'duplicate' }) : reuse();

  const ctx = await deps.staff.context(pr.restaurant_id);
  const flags = { unknown_actor: [p.staff_id as string | null, p.by_staff_id as string | null].some((id) => !knownActor(ctx, id)) };
  const nowIso = new Date(deps.now()).toISOString();
  const response = { result: 'applied', id: p.event_id, version: 1, server_version: 1, flags, server_time: nowIso };
  const inserted = await deps.staff.insertEvent({ event_id: p.event_id, restaurant_id: pr.restaurant_id, device_id: pr.device_id, payload: p, content_hash: p.content_hash as string, flags, response, received_at: nowIso });
  if (!inserted) {
    // a concurrent insert of the same event id won: answer as §3.1 / §3a would have
    const won = await deps.staff.getEvent(p.event_id);
    if (!won || won.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', 'it belongs to another restaurant');
    return won.content_hash === p.content_hash ? okResult({ ...won.response, result: 'duplicate' }) : reuse();
  }
  return okResult(response);
}
