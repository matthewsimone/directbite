/**
 * KitchenHub line → Ordr menu item / category (CP21, Matt). Pure: the feed (wire.ts khOrderWire), the action /
 * print answers (the same served order) and pos-v1-kitchenhub-items (list) resolve a line the same way.
 *
 * Live data (Matt, 2026-11-24): ubereats 9 lines / 0 with id, grubhub 4 / 0, doordash 42 / 13 with id / 0
 * partner_id, doordash_pos 1 / 1 / 1 → the NORMALIZED NAME is the primary key for most marketplaces.
 *
 * Resolution, first hit wins (resolveLine):
 *   1. partner_id = the id of a CURRENT menu item of this restaurant (a KitchenHub menu push, later) → that item.
 *   2. an item_id map for (marketplace, the line's id) — only when the line has an id.
 *   3. a name map for (marketplace, normalizeItemName(name)).
 *   4. a name map for (marketplace, the name without an EXACT size suffix) — sizeStem below.
 *   (2–4: a map for the marketplace itself first, then one for '*' = every marketplace.)
 *   5. the restaurant's fallback category (pos_restaurant_settings.kitchenhub_fallback_category_id) — mapped false.
 *   6. nothing — menu_item_id / category_id null, mapped false: the counter (expo) ticket only, marked UNMAPPED.
 * A map whose target is gone (menu item / category deleted) is skipped — the line falls through, never dropped.
 * Name suggestions are SUGGESTIONS only (list), never applied.
 */

/**
 * The name key: Unicode NFKC → lowercase → '&' → ' and ' → every character that is not a letter / digit → a
 * space → collapse whitespace → trim. Nothing else: no stemming, no plural folding, no word dropping.
 *   "Cheese Pizza"        → "cheese pizza"
 *   "  CHEESE   PIZZA! "  → "cheese pizza"
 *   "Chicken-Parm Hero"   → "chicken parm hero"
 *   "Mac & Cheese"        → "mac and cheese"
 *   "Café Latte"          → "café latte"
 */
export function normalizeItemName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The size words a suffix must EQUAL (after normalizeItemName) to be stripped. Inches: 6–36 with in / inch /
 * inches / ". Anything else is part of the name.
 */
const SIZE_WORDS = new Set([
  'small', 'sm', 'medium', 'med', 'md', 'large', 'lg', 'x large', 'xl', 'extra large', 'xx large', 'xxl',
  'personal', 'individual', 'regular', 'family', 'family size', 'party', 'party size', 'mini', 'jumbo',
]);
const INCHES = /^([6-9]|[12]\d|3[0-6]) ?(in|inch|inches|")$/;
function isSizeWord(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (INCHES.test(t)) return true; // before punctuation stripping: 16" keeps its quote
  return SIZE_WORDS.has(normalizeItemName(raw));
}

/**
 * The name without a size suffix — ONLY when the suffix is EXACTLY a size word (SIZE_WORDS / inches) in one of
 * these forms: "<name> (<size>)", "<name> - <size>", "<name>, <size>", "<size> <name>" is NOT stripped (a leading
 * word is too often part of the name: "Large Fries"). null = no exact size suffix (no stem lookup).
 *   "Cheese Pizza (Large)"   → "cheese pizza"
 *   "Cheese Pizza - 16\""    → "cheese pizza"
 *   "Cheese Pizza, Small"    → "cheese pizza"
 *   "Cheese Pizza Large"     → null (no separator: not exact)
 *   "Wings (10 pc)"          → null (not a size word)
 */
export function sizeStem(name: string): string | null {
  const m = /^(.*\S)\s*(?:\(([^()]+)\)|\s-\s(.+)|,\s*(.+))\s*$/.exec(name.trim());
  if (!m) return null;
  const suffix = m[2] ?? m[3] ?? m[4] ?? '';
  if (!isSizeWord(suffix)) return null;
  const stem = normalizeItemName(m[1]);
  return stem ? stem : null;
}

export type MatchKind = 'item_id' | 'name';

export interface ItemMapRow {
  /** The marketplace (external_orders.provider_id, lowercase) or '*' = every marketplace. */
  provider: string;
  match_kind: MatchKind;
  /** item_id: the marketplace's item id as sent; name: normalizeItemName(name). */
  match_key: string;
  menu_item_id: string | null;
  category_id: string | null;
  label: string | null;
}

/** What one served order needs: the restaurant's maps, its current menu items → category, its categories, fallback. */
export interface KhMapContext {
  /** `${provider}|${kind}|${key}` → map. */
  maps: Map<string, ItemMapRow>;
  /** current menu_items of the restaurant: id → category_id. */
  itemCategory: Map<string, string>;
  /** current menu_categories ids of the restaurant. */
  categories: Set<string>;
  fallbackCategoryId: string | null;
}

export const EMPTY_KH_CONTEXT: KhMapContext = { maps: new Map(), itemCategory: new Map(), categories: new Set(), fallbackCategoryId: null };

export const mapKey = (provider: string, kind: MatchKind, key: string) => `${provider}|${kind}|${key}`;

export function khMapContext(
  maps: readonly ItemMapRow[], items: readonly { id: string; category_id: string | null }[], categories: readonly { id: string }[],
  fallbackCategoryId: string | null,
): KhMapContext {
  const m = new Map<string, ItemMapRow>();
  for (const r of maps) m.set(mapKey(String(r.provider).toLowerCase(), r.match_kind, r.match_key), r);
  const ic = new Map<string, string>();
  for (const i of items) if (typeof i.id === 'string' && typeof i.category_id === 'string') ic.set(i.id.toLowerCase(), i.category_id.toLowerCase());
  const cs = new Set(categories.map((c) => String(c.id).toLowerCase()));
  const fb = fallbackCategoryId && cs.has(fallbackCategoryId.toLowerCase()) ? fallbackCategoryId.toLowerCase() : null;
  return { maps: m, itemCategory: ic, categories: cs, fallbackCategoryId: fb };
}

/** The line's own keys (the marketplace JSON). */
export interface LineKeys { provider: string; item_id: string | null; partner_id: string | null; name: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.length <= 200 ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null;

export function lineKeys(providerId: unknown, it: unknown): LineKeys {
  const o = it && typeof it === 'object' && !Array.isArray(it) ? it as Record<string, unknown> : {};
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name : null;
  return { provider: String(providerId ?? '').toLowerCase(), item_id: idOf(o.id), partner_id: idOf(o.partner_id), name };
}

export type ResolvedVia = 'partner_id' | 'item_id' | 'name' | 'name_size_stem' | 'fallback' | 'none';
export interface Resolved { menu_item_id: string | null; category_id: string | null; mapped: boolean; via: ResolvedVia; map: ItemMapRow | null }

/** A map's target as it stands now (null = the target is gone → skipped). */
function target(ctx: KhMapContext, r: ItemMapRow): { menu_item_id: string | null; category_id: string } | null {
  if (r.menu_item_id) {
    const c = ctx.itemCategory.get(r.menu_item_id.toLowerCase());
    return c ? { menu_item_id: r.menu_item_id.toLowerCase(), category_id: c } : null;
  }
  if (r.category_id && ctx.categories.has(r.category_id.toLowerCase())) return { menu_item_id: null, category_id: r.category_id.toLowerCase() };
  return null;
}

export function findMap(ctx: KhMapContext, k: LineKeys): { map: ItemMapRow; via: ResolvedVia; to: { menu_item_id: string | null; category_id: string } } | null {
  const tries: [MatchKind, string | null, ResolvedVia][] = [
    ['item_id', k.item_id, 'item_id'],
    ['name', k.name ? normalizeItemName(k.name) || null : null, 'name'],
    ['name', k.name ? sizeStem(k.name) : null, 'name_size_stem'],
  ];
  for (const [kind, key, via] of tries) {
    if (!key) continue;
    for (const p of [k.provider, '*']) {
      const r = ctx.maps.get(mapKey(p, kind, key));
      const to = r ? target(ctx, r) : null;
      if (r && to) return { map: r, via, to };
    }
  }
  return null;
}

export function resolveLine(ctx: KhMapContext, k: LineKeys): Resolved {
  if (k.partner_id && UUID.test(k.partner_id)) {
    const c = ctx.itemCategory.get(k.partner_id.toLowerCase());
    if (c) return { menu_item_id: k.partner_id.toLowerCase(), category_id: c, mapped: true, via: 'partner_id', map: null };
  }
  const f = findMap(ctx, k);
  if (f) return { ...f.to, mapped: true, via: f.via, map: f.map };
  if (ctx.fallbackCategoryId) return { menu_item_id: null, category_id: ctx.fallbackCategoryId, mapped: false, via: 'fallback', map: null };
  return { menu_item_id: null, category_id: null, mapped: false, via: 'none', map: null };
}

/**
 * Name SUGGESTIONS for a line (list only — never applied): menu items whose normalized name equals the line's
 * normalized name, then its size stem, then contains / is contained by it (≥ 4 characters). At most 3, in that order.
 */
export function suggestItems(name: string, menu: readonly { id: string; name: string; category_id: string | null }[]): { menu_item_id: string; name: string; category_id: string | null; why: 'exact' | 'size_stem' | 'contains' }[] {
  const n = normalizeItemName(name);
  const stem = sizeStem(name);
  const out: { menu_item_id: string; name: string; category_id: string | null; why: 'exact' | 'size_stem' | 'contains' }[] = [];
  const seen = new Set<string>();
  const add = (i: { id: string; name: string; category_id: string | null }, why: 'exact' | 'size_stem' | 'contains') => {
    if (seen.has(i.id) || out.length >= 3) return;
    seen.add(i.id);
    out.push({ menu_item_id: i.id, name: i.name, category_id: i.category_id, why });
  };
  const norm = menu.map((i) => ({ i, k: normalizeItemName(String(i.name ?? '')) })).filter((x) => x.k);
  for (const x of norm) if (x.k === n) add(x.i, 'exact');
  if (stem) for (const x of norm) if (x.k === stem) add(x.i, 'size_stem');
  if (n.length >= 4) for (const x of norm) if (x.k.length >= 4 && (x.k.includes(n) || n.includes(x.k))) add(x.i, 'contains');
  return out;
}
