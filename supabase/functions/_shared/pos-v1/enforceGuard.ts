/**
 * CP8 enforce guard for create-payment-intent. ZERO imports on purpose (like shadowGuard.ts): it is
 * the only enforcement file the payment function imports statically. The pricer + hours code is
 * loaded with a dynamic import inside `run`, and ONLY for a restaurant on the enforce list, so a
 * restaurant that isn't listed can never be affected by it — not even by a module load failure.
 *
 * POS_V1_ENFORCE_RESTAURANTS (function secret): comma-separated restaurant ids. Empty / unset =
 * enforcement off everywhere = byte-identical behavior to before CP8.
 */

export interface GuardBlock {
  status: number;
  body: Record<string, unknown>;
}

/** Comma-separated ids → lowercase set. Empty / unset / garbage = empty set. Never throws. */
export function parseEnforceList(raw: string | undefined | null): Set<string> {
  try {
    return new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function isEnforced(list: Set<string>, restaurantId: unknown): boolean {
  return typeof restaurantId === 'string' && list.has(restaurantId.toLowerCase());
}

/**
 * Not listed → null WITHOUT calling `run` (no DB access, no import). Listed → `run()`'s verdict;
 * any throw from `run` (including a failed dynamic import) → 503 pricing_unavailable (fail closed).
 */
export async function guardCheckout(
  list: Set<string>,
  restaurantId: unknown,
  run: () => Promise<GuardBlock | null>,
  log: (event: string, data: Record<string, unknown>) => void = () => {},
): Promise<GuardBlock | null> {
  if (!isEnforced(list, restaurantId)) return null;
  try {
    return await run();
  } catch (err) {
    try {
      log('enforce failed', { restaurant_id: restaurantId, error: err instanceof Error ? err.message : String(err) });
    } catch {
      // a broken logger must not change the verdict
    }
    return { status: 503, body: { error: 'pricing_unavailable', reason: 'internal_error' } };
  }
}
