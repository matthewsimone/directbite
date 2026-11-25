/**
 * pos-v1-kitchenhub-items (CP21, Matt): staff map marketplace (KitchenHub) items to the Ordr menu ONCE, from a
 * register, so marketplace lines route by category → printer like in-store orders (the register's station routing,
 * ordr-pos src/db/repo/print.ts onlineStationRoutes). READ-ONLY toward KitchenHub: nothing is pushed.
 *
 *   op list   every marketplace item the restaurant has: the names / ids seen on its last 30 days of external_orders
 *             MERGED with the marketplace menu pull (GET /v2/stores/{store_id}/menu/pull?provider_id=…, cached per
 *             restaurant ≥ 5 min in pos_kitchenhub_menu_pulls; a failed pull is cached 60 s and the list is the
 *             seen-in-orders items only — never an error). Each entry: how it resolves NOW (khItems.ts resolveLine),
 *             the map that hits, and name SUGGESTIONS (never applied). + every map (a gone target flagged) + the
 *             fallback category.
 *   op set    a map {provider ('*' = every marketplace), kind item_id | name, value} → menu_item_id XOR category_id;
 *             kind fallback → category_id (pos_restaurant_settings.kitchenhub_fallback_category_id).
 *   op clear  the same key → removed (fallback → null).
 * set / clear: idempotent by a UUID action_id (pos_online_actions, function 'settings'; 117
 * pos_kitchenhub_item_map_change — one transaction). A name key is stored NORMALIZED (khItems.ts normalizeItemName);
 * the label keeps the text as staff saw it. Target not on this restaurant's menu → 404 item_not_found /
 * category_not_found.
 */
import { authenticateDevice } from '../pos-device/auth.ts';
import { restaurantIdentity } from '../pos-device/identity.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { UUID_RE } from '../pos-sync/orderPayload.ts';
import { bad, isoOrNullTime, isResult, readRows, whoOf, type OnlineDeps } from './handlers.ts';
import { khMapContext, lineKeys, normalizeItemName, resolveLine, sizeStem, suggestItems, type ItemMapRow, type MatchKind } from './khItems.ts';
import { OnlineStoreError, type MenuPullRow } from './store.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const MENU_PULL_TTL_MS = 5 * 60_000;
export const MENU_PULL_FAILED_TTL_MS = 60_000;
export const SEEN_DAYS = 30;
export const SEEN_ROW_CAP = 1000;
const PROVIDER_RE = /^[a-z0-9_]{1,40}$/;
const VALUE_MAX = 200;

export async function handleKitchenhubItems(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value as Row;
  const mismatch = restaurantIdentity(body, a.principal);
  if (mismatch) return mismatch;
  const rid = a.principal.restaurant_id;
  if (body.op === 'list') return list(deps, rid);
  if (body.op === 'set' || body.op === 'clear') return write(deps, a.principal, body);
  return bad('op', 'op must be list, set or clear');
}

// ---- list ---------------------------------------------------------------------------------------------------------

interface Entry {
  provider: string; name: string | null; name_key: string | null; size_stem_key: string | null; item_ids: string[]; partner_ids: string[];
  seen_count: number; last_seen_at: string | null; on_marketplace_menu: boolean;
  resolved: { via: string; mapped: boolean; menu_item_id: string | null; category_id: string | null; map: { provider: string; kind: MatchKind; key: string } | null };
  suggestions: ReturnType<typeof suggestItems>;
}

async function list(deps: OnlineDeps, rid: string): Promise<DeviceResult> {
  const nowMs = deps.now();
  const since = new Date(nowMs - SEEN_DAYS * 86_400_000).toISOString();
  const [seen, maps, items, cats, pos, store, statusRows] = await Promise.all([
    readRows<Row>('external_orders', deps.db.from('external_orders').select('provider_id, items, created_at').eq('restaurant_id', rid)
      .gte('created_at', since).order('created_at', { ascending: false }).limit(SEEN_ROW_CAP)),
    readRows<ItemMapRow & { updated_at?: string }>('pos_kitchenhub_item_maps', deps.db.from('pos_kitchenhub_item_maps')
      .select('provider,match_kind,match_key,menu_item_id,category_id,label,updated_at').eq('restaurant_id', rid)),
    readRows<{ id: string; name: string; category_id: string | null }>('menu_items', deps.db.from('menu_items').select('id,name,category_id').eq('restaurant_id', rid)),
    readRows<{ id: string; name: string }>('menu_categories', deps.db.from('menu_categories').select('id,name').eq('restaurant_id', rid)),
    deps.online.getSettings(rid),
    deps.db.from('kitchenhub_stores').select('kh_store_id').eq('restaurant_id', rid).maybeSingle(),
    readRows<{ provider_id: string }>('dsp_provider_status', deps.db.from('dsp_provider_status').select('provider_id').eq('restaurant_id', rid)),
  ]);
  const ctx = khMapContext(maps, items, cats, pos?.kitchenhub_fallback_category_id ?? null);

  const entries = new Map<string, Entry & { _ids: Set<string>; _pids: Set<string> }>();
  const entryFor = (provider: string, name: string | null, itemId: string | null) => {
    const nk = name ? normalizeItemName(name) || null : null;
    const k = nk ? `${provider}|n|${nk}` : itemId ? `${provider}|i|${itemId}` : null;
    if (!k) return null;
    let e = entries.get(k);
    if (!e) {
      e = {
        provider, name, name_key: nk, size_stem_key: name ? sizeStem(name) : null, item_ids: [], partner_ids: [], seen_count: 0,
        last_seen_at: null, on_marketplace_menu: false, _ids: new Set(), _pids: new Set(),
        resolved: { via: 'none', mapped: false, menu_item_id: null, category_id: null, map: null }, suggestions: [],
      };
      entries.set(k, e);
    }
    if (itemId) e._ids.add(itemId);
    return e;
  };
  for (const o of seen) {
    const lines = Array.isArray(o.items) ? o.items : [];
    for (const it of lines) {
      const k = lineKeys(o.provider_id, it);
      const e = entryFor(k.provider, k.name, k.item_id);
      if (!e) continue;
      if (k.partner_id) e._pids.add(k.partner_id);
      e.seen_count += 1;
      if (typeof o.created_at === 'string' && (!e.last_seen_at || o.created_at > e.last_seen_at)) e.last_seen_at = o.created_at;
    }
  }
  const providers = [...new Set([...statusRows.map((r) => String(r.provider_id).toLowerCase()), ...seen.map((o) => String(o.provider_id ?? '').toLowerCase())])]
    .filter((p) => PROVIDER_RE.test(p)).sort();
  const pull = await menuPull(deps, rid, typeof store.data?.kh_store_id === 'string' ? store.data.kh_store_id : null, providers, nowMs);
  for (const p of pull.row?.providers ?? []) {
    if (!p.ok) continue;
    for (const it of p.items) {
      const e = entryFor(p.provider, it.name, null);
      if (e) e.on_marketplace_menu = true;
    }
  }

  const out: Entry[] = [...entries.values()].map((e) => {
    const ids = [...e._ids].sort();
    const pids = [...e._pids].sort();
    const r = resolveLine(ctx, { provider: e.provider, item_id: ids[0] ?? null, partner_id: pids[0] ?? null, name: e.name });
    const { _ids: _i, _pids: _p, ...rest } = e;
    void _i;
    void _p;
    return {
      ...rest, item_ids: ids, partner_ids: pids,
      resolved: { via: r.via, mapped: r.mapped, menu_item_id: r.menu_item_id, category_id: r.category_id, map: r.map ? { provider: r.map.provider, kind: r.map.match_kind, key: r.map.match_key } : null },
      suggestions: e.name ? suggestItems(e.name, items) : [],
    };
  }).sort((x, y) => Number(x.resolved.mapped) - Number(y.resolved.mapped) || y.seen_count - x.seen_count || String(x.name).localeCompare(String(y.name)));

  return okResult({
    entries: out,
    maps: maps.map((m) => ({
      provider: m.provider, kind: m.match_kind, key: m.match_key, label: m.label ?? null, menu_item_id: m.menu_item_id ?? null, category_id: m.category_id ?? null,
      target_exists: m.menu_item_id ? ctx.itemCategory.has(String(m.menu_item_id).toLowerCase()) : ctx.categories.has(String(m.category_id).toLowerCase()),
      updated_at: m.updated_at ?? null,
    })),
    fallback_category_id: pos?.kitchenhub_fallback_category_id ?? null,
    menu_pull: {
      status: pull.status, pulled_at: pull.row?.pulled_at ?? null,
      providers: (pull.row?.providers ?? []).map((p) => ({ provider: p.provider, ok: p.ok, items: p.items.length })),
    },
    server_time: new Date(nowMs).toISOString(),
  });
}

type PullStatus = 'cached' | 'pulled' | 'failed' | 'no_store' | 'not_configured' | 'no_providers';

/** The marketplace menus (read-only): the cache if fresh, else one pull per marketplace. Never throws. */
async function menuPull(deps: OnlineDeps, rid: string, storeId: string | null, providers: string[], nowMs: number): Promise<{ status: PullStatus; row: MenuPullRow | null }> {
  let cached: MenuPullRow | null = null;
  try {
    cached = await deps.online.getMenuPull(rid);
  } catch (err) {
    deps.log('kh_menu_pull_cache_unavailable', { restaurant_id: rid, error: err instanceof Error ? err.message : String(err) });
  }
  if (cached) {
    const age = nowMs - Date.parse(cached.pulled_at);
    if (Number.isFinite(age) && age >= 0 && age < (cached.ok ? MENU_PULL_TTL_MS : MENU_PULL_FAILED_TTL_MS)) return { status: 'cached', row: cached };
  }
  if (!storeId) return { status: 'no_store', row: null };
  if (!deps.khFetch) return { status: 'not_configured', row: null };
  if (!providers.length) return { status: 'no_providers', row: null };
  const results: MenuPullRow['providers'] = [];
  for (const p of providers) {
    try {
      const res = await deps.khFetch(deps.db, `/v2/stores/${encodeURIComponent(storeId)}/menu/pull?provider_id=${encodeURIComponent(p)}`, { method: 'GET' });
      if (!res.ok) {
        await res.body?.cancel();
        deps.log('kh_menu_pull_failed', { restaurant_id: rid, provider: p, http: res.status });
        results.push({ provider: p, ok: false, items: [] });
        continue;
      }
      const j = await res.json().catch(() => null);
      const arr: unknown[] = Array.isArray(j?.items) ? j.items : [];
      const seenNames = new Set<string>();
      const items: { item_id: string | null; name: string }[] = [];
      for (const it of arr) {
        const o = it && typeof it === 'object' ? it as Row : {};
        const name = typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, VALUE_MAX) : null;
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        items.push({ item_id: typeof o.provider_id === 'string' && o.provider_id ? o.provider_id.slice(0, VALUE_MAX) : null, name });
      }
      results.push({ provider: p, ok: true, items });
    } catch (err) {
      deps.log('kh_menu_pull_failed', { restaurant_id: rid, provider: p, error: err instanceof Error ? err.message : String(err) });
      results.push({ provider: p, ok: false, items: [] });
    }
  }
  const row: MenuPullRow = { restaurant_id: rid, pulled_at: new Date(nowMs).toISOString(), ok: results.every((r) => r.ok), providers: results };
  try {
    await deps.online.putMenuPull(row);
  } catch (err) {
    deps.log('kh_menu_pull_cache_write_failed', { restaurant_id: rid, error: err instanceof Error ? err.message : String(err) });
  }
  return { status: results.some((r) => r.ok) ? 'pulled' : 'failed', row };
}

// ---- set / clear --------------------------------------------------------------------------------------------------

async function write(deps: OnlineDeps, pr: { restaurant_id: string; device_id: string }, body: Row): Promise<DeviceResult> {
  const rid = pr.restaurant_id;
  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  const key = body.key;
  if (!key || typeof key !== 'object' || Array.isArray(key)) return bad('key', 'key is required');
  const kind = key.kind;
  if (kind !== 'item_id' && kind !== 'name' && kind !== 'fallback') return bad('key.kind', 'key.kind must be item_id, name or fallback');
  const op: 'set' | 'clear' = body.op;
  let provider: string | null = null;
  let matchKey: string | null = null;
  let label: string | null = null;
  if (kind !== 'fallback') {
    const pv: string = typeof key.provider === 'string' ? key.provider.trim().toLowerCase() : '';
    if (pv !== '*' && !PROVIDER_RE.test(pv)) return bad('key.provider', "key.provider must be a marketplace id or '*'");
    provider = pv;
    const v = typeof key.value === 'string' ? key.value.trim() : '';
    if (!v || v.length > VALUE_MAX) return bad('key.value', `key.value is required (≤ ${VALUE_MAX} characters)`);
    matchKey = kind === 'name' ? normalizeItemName(v) : v;
    if (!matchKey) return bad('key.value', 'the name has no letters or digits');
    label = kind === 'name' ? v : typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, VALUE_MAX) : null;
  }
  let menuItemId: string | null = null;
  let categoryId: string | null = null;
  if (op === 'set') {
    const mi = body.menu_item_id ?? null;
    const ci = body.category_id ?? null;
    if (!(mi === null || (typeof mi === 'string' && UUID_RE.test(mi)))) return bad('menu_item_id', 'menu_item_id must be a menu item id or null');
    if (!(ci === null || (typeof ci === 'string' && UUID_RE.test(ci)))) return bad('category_id', 'category_id must be a category id or null');
    if (kind === 'fallback' ? ci === null || mi !== null : (mi === null) === (ci === null)) {
      return bad(kind === 'fallback' ? 'category_id' : 'menu_item_id', kind === 'fallback' ? 'the fallback is a category_id' : 'exactly one of menu_item_id / category_id');
    }
    menuItemId = mi === null ? null : mi.toLowerCase();
    categoryId = ci === null ? null : ci.toLowerCase();
    // the restaurant's CURRENT menu (the SQL function re-checks in its transaction)
    if (menuItemId) {
      const { data, error } = await deps.db.from('menu_items').select('id').eq('id', menuItemId).eq('restaurant_id', rid).maybeSingle();
      if (error) throw new Error(`menu_items read failed: ${error.message}`);
      if (!data) return errorResult(404, 'item_not_found', 'no such item on the current menu', { field: 'menu_item_id' });
    }
    if (categoryId) {
      const { data, error } = await deps.db.from('menu_categories').select('id').eq('id', categoryId).eq('restaurant_id', rid).maybeSingle();
      if (error) throw new Error(`menu_categories read failed: ${error.message}`);
      if (!data) return errorResult(404, 'category_not_found', 'no such category on the current menu', { field: 'category_id' });
    }
  }
  const who = whoOf(body);
  if (isResult(who)) return who;
  const { device_time: _dt, ...request } = body;
  void _dt;
  let out;
  try {
    out = await deps.online.kitchenhubMapChange({
      actionId: body.action_id.toLowerCase(), restaurantId: rid, deviceId: pr.device_id, op, kind, provider, key: matchKey, menuItemId, categoryId, label,
      request, actor: who.actor, approver: who.approver, deviceTime: isoOrNullTime(body.device_time),
    });
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad('key', err.message);
    throw err;
  }
  switch (out.outcome) {
    case 'device_not_allowed':
      return errorResult(403, 'device_not_allowed', 'this register is not active');
    case 'action_id_reused':
      return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
    case 'item_not_found':
      return errorResult(404, 'item_not_found', 'no such item on the current menu', { field: 'menu_item_id' });
    case 'category_not_found':
      return errorResult(404, 'category_not_found', 'no such category on the current menu', { field: 'category_id' });
  }
  const result = out.outcome === 'duplicate' ? 'duplicate' : out.outcome;
  let map: Row | null = null;
  if (kind !== 'fallback') {
    const { data, error } = await deps.db.from('pos_kitchenhub_item_maps').select('provider,match_kind,match_key,menu_item_id,category_id,label,updated_at')
      .eq('restaurant_id', rid).eq('provider', provider).eq('match_kind', kind).eq('match_key', matchKey).maybeSingle();
    if (error) throw new Error(`pos_kitchenhub_item_maps read failed: ${error.message}`);
    map = data ? { provider: data.provider, kind: data.match_kind, key: data.match_key, label: data.label ?? null, menu_item_id: data.menu_item_id ?? null, category_id: data.category_id ?? null, updated_at: data.updated_at ?? null } : null;
  }
  const pos = await deps.online.getSettings(rid);
  return okResult({ result, map, fallback_category_id: pos?.kitchenhub_fallback_category_id ?? null, server_time: new Date(deps.now()).toISOString() });
}
