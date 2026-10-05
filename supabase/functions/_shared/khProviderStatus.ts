// ============================================================================
// KitchenHub provider-status webhooks → dsp_provider_status fields
// ============================================================================
// Pure functions, erasable TS only (node tests import this file directly).
//   IntegrationAccount             → connection_status (+ comment as reason)
//   IntegrationAccountOnlineStatus → online_status, offline reason, pause_until
// Each event writes only its own columns so the two event types never clobber
// each other's state on the shared (restaurant_id, provider_id) row.
// ============================================================================

export const PROVIDER_STATUS_TYPES = ["IntegrationAccount", "IntegrationAccountOnlineStatus"];

// KitchenHub "restaurant" ids to try against kitchenhub_stores.kh_store_id.
// deno-lint-ignore no-explicit-any
export function providerStatusStoreIds(payload: any): string[] {
  const r = payload?.restaurant_data ?? {};
  const ids: string[] = [];
  for (const v of [r.restaurant_id, r.proxy_restaurant_id]) {
    if ((typeof v === "string" || typeof v === "number") && String(v) && !ids.includes(String(v))) {
      ids.push(String(v));
    }
  }
  return ids;
}

// Null when the payload has no provider_id (can't key the row).
export function toProviderStatusPatch(
  webhookType: string,
  // deno-lint-ignore no-explicit-any
  payload: any,
  nowMs: number,
): { provider_id: string; fields: Record<string, unknown> } | null {
  if (webhookType === "IntegrationAccount") {
    const d = payload?.integration_account_data;
    if (!d?.provider_id) return null;
    return {
      provider_id: String(d.provider_id),
      fields: {
        account_id: d.account_id ?? null,
        connection_status: d.connection_status ?? null,
        reason: d.connection_status_comment ?? null,
      },
    };
  }
  if (webhookType === "IntegrationAccountOnlineStatus") {
    const d = payload?.online_status_data;
    if (!d?.provider_id) return null;
    const status = d.online_status ?? null;
    if (status === "online") {
      return {
        provider_id: String(d.provider_id),
        fields: { account_id: d.account_id ?? null, online_status: "online", reason: null, pause_until: null },
      };
    }
    const secs = Number(d.pause_duration_seconds);
    return {
      provider_id: String(d.provider_id),
      fields: {
        account_id: d.account_id ?? null,
        online_status: status,
        reason: d.offline_reason ?? null,
        pause_until: Number.isFinite(secs) && secs > 0 ? new Date(nowMs + secs * 1000).toISOString() : null,
      },
    };
  }
  return null;
}
