// ============================================================================
// ChowNow menu translator
// ============================================================================
//
// Pure, dependency-free translation of a pasted ChowNow menu JSON into the two
// payload shapes DirectBite's EXISTING write paths already consume:
//
//   1. `menu`           → the import-menu output contract
//                         ({ source_url, categories: [{ name, sort_order,
//                            items: [{ name, description, base_price,
//                            image_url, is_best_seller, sort_order }] }] })
//                         fed to MenuImportModal's menu writer (creates
//                         menu_categories, menu_items, placeholder item_sizes).
//
//   2. `captured_items` → the import-modifiers input contract
//                         ([{ item_name, category, image_url, source_url,
//                            captured_at, modifier_groups: [{ label, is_size,
//                            selection_type, required, max_selections,
//                            options: [{ name, price, is_default }] }] }])
//                         POSTed to /api/import-modifiers (enriches sizes,
//                         topping_groups, toppings, links).
//
// No live fetch (ChowNow is bot-protected) — the admin pastes the JSON.
// All ChowNow-specific knowledge lives here; the write paths stay untouched.
//
// Mapping rules (see also the import proposal):
//   - Every menu_categories entry imports as a normal category, INCLUDING
//     "Popular Items" (id "0"). No is_popular flag. Item dedup is per-category
//     (handled downstream by category::name), so the same item in Popular and
//     its home category becomes two rows — intended.
//   - Normal item (is_meta=false): base_price = item.price, no size group →
//     the writer's placeholder item_sizes(name:'') stands (no size picker).
//   - Meta item (is_meta=true): sizes from
//     meta_item_details.serving_size_group.child_items[] (name=child.size,
//     price=child.price). Emitted as an is_size group so import-modifiers
//     replaces the placeholder size. default_id is respected by ordering the
//     default child first (the size write orders by index, ignoring is_default).
//     base_price = the default child's price (the single-size rename path
//     updates name only, not price, so this keeps it correct).
//   - modifier_categories → topping_groups, modifiers → toppings (id refs
//     resolved). placement_type is always 'addon' (decided downstream — no
//     pizza). selection_type: max_qty==1 → single, max_qty==null → unlimited.
//   - Required single-select (min_qty>=1, max_qty==1) with no is_default
//     modifier → force the FIRST option default (DirectBite encodes "required"
//     via a default existing; ChowNow encodes it via min_qty).
//   - Images are always null here — no hosting path is exercised.
// ============================================================================

const SIZE_GROUP_LABEL = 'Choose an option'

function toStr(v) {
  return v == null ? '' : String(v)
}

function trimOrNull(v) {
  const s = toStr(v).trim()
  return s || null
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Build the modifier groups for an item from its modifier_category id refs.
// Pushes human-readable notes to `warnings`. `ctx` labels the item for those.
function resolveToppingGroups(modCatIds, catById, modifiersById, ctx, warnings) {
  const groups = []
  for (const cid of modCatIds || []) {
    const cat = catById.get(toStr(cid))
    if (!cat) {
      warnings.push(`${ctx}: modifier category ${cid} not found — skipped`)
      continue
    }

    const maxQ = cat.max_qty
    const minQ = num(cat.min_qty)
    let selection_type
    let max_selections
    if (maxQ === 1) {
      selection_type = 'single'
      max_selections = 1
    } else if (maxQ == null) {
      selection_type = 'unlimited'
      max_selections = null
    } else {
      // Capped multi-select. DirectBite persists only single (max 1) or
      // unlimited (no cap) — import-modifiers nulls max_selections for
      // unlimited — so the cap can't be represented without a schema change.
      selection_type = 'unlimited'
      max_selections = null
      warnings.push(
        `${ctx}: "${cat.name}" allows up to ${maxQ} — DirectBite can't cap a multi-select; imported as unlimited (cap dropped)`
      )
    }

    const options = []
    for (const mid of cat.modifiers || []) {
      const mod = modifiersById.get(toStr(mid))
      if (!mod) {
        warnings.push(`${ctx}: modifier ${mid} in "${cat.name}" not found — skipped`)
        continue
      }
      const name = toStr(mod.name).trim()
      if (!name) continue
      options.push({ name, price: num(mod.price), is_default: !!mod.is_default })
    }
    if (options.length === 0) {
      warnings.push(`${ctx}: "${cat.name}" had no resolvable options — skipped`)
      continue
    }

    const required = minQ >= 1
    if (required && !options.some((o) => o.is_default)) {
      if (selection_type === 'single') {
        options[0].is_default = true
        warnings.push(
          `${ctx}: "${cat.name}" is required but had no default — set "${options[0].name}" as default`
        )
      } else {
        // Required multi-select with no default: left as-is per spec.
        warnings.push(
          `${ctx}: "${cat.name}" is a required multi-select with no default — left without a forced default`
        )
      }
    }

    groups.push({
      label: toStr(cat.name).trim() || '(unnamed group)',
      selection_type,
      required,
      max_selections,
      options,
    })
  }
  return groups
}

// Build the is_size group + base_price for a meta item from its
// serving_size_group. Returns null if the meta item has no usable sizes.
function buildMetaSize(item, ctx, warnings) {
  const ssg = item.meta_item_details?.serving_size_group
  const children = Array.isArray(ssg?.child_items) ? ssg.child_items : []
  if (children.length === 0) {
    warnings.push(`${ctx}: meta item with no sizes — skipped`)
    return null
  }

  const defaultId = toStr(ssg?.default_id)
  const ordered = children.slice()
  const di = ordered.findIndex((c) => toStr(c.id) === defaultId && defaultId)
  if (di > 0) ordered.unshift(ordered.splice(di, 1)[0])

  const defChild = children.find((c) => toStr(c.id) === defaultId && defaultId) || children[0]
  const base_price = num(defChild.price)

  if (children.some((c) => (c.modifier_categories || []).length > 0)) {
    warnings.push(`${ctx}: per-size modifiers are not supported — ignored`)
  }

  const options = ordered.map((c, i) => ({
    name: toStr(c.size).trim() || `Size ${i + 1}`,
    price: num(c.price),
    is_default: toStr(c.id) === defaultId && !!defaultId,
  }))

  const group = {
    is_size: true,
    label: SIZE_GROUP_LABEL,
    selection_type: 'single',
    required: true,
    max_selections: 1,
    options,
  }
  return { group, base_price }
}

/**
 * Translate a ChowNow menu payload into DirectBite's two import contracts.
 *
 * @param {object|string} raw - the ChowNow JSON (object or string to parse).
 * @returns {{ menu: object, captured_items: object[], warnings: string[] }}
 */
export function translateChowNow(raw) {
  const json = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!json || typeof json !== 'object') {
    throw new Error('ChowNow JSON must be an object')
  }
  if (!Array.isArray(json.menu_categories)) {
    throw new Error('ChowNow JSON missing menu_categories array')
  }

  const warnings = []

  const modifiersById = new Map()
  for (const m of json.modifiers || []) modifiersById.set(toStr(m.id), m)
  const catById = new Map()
  for (const c of json.modifier_categories || []) catById.set(toStr(c.id), c)

  const categories = []
  const captured_items = []

  for (const cat of json.menu_categories) {
    const categoryName = toStr(cat?.name).trim()
    if (!categoryName) continue

    const items = []
    for (const item of cat.items || []) {
      const name = toStr(item?.name).trim()
      if (!name) continue
      const ctx = `"${name}" [${categoryName}]`

      const modifier_groups = []
      let base_price

      if (item.is_meta) {
        const meta = buildMetaSize(item, ctx, warnings)
        if (!meta) continue // skipped — no usable sizes
        base_price = meta.base_price
        modifier_groups.push(meta.group)
        // Meta items rarely carry their own top-level modifier categories,
        // but support it: they apply across all sizes, after the size group.
        modifier_groups.push(
          ...resolveToppingGroups(item.modifier_categories, catById, modifiersById, ctx, warnings)
        )
      } else {
        if (item.price == null) {
          warnings.push(`${ctx}: no price — skipped`)
          continue
        }
        base_price = num(item.price)
        modifier_groups.push(
          ...resolveToppingGroups(item.modifier_categories, catById, modifiersById, ctx, warnings)
        )
      }

      items.push({
        name,
        description: trimOrNull(item.description),
        base_price,
        image_url: null,
        is_best_seller: false,
        sort_order: items.length + 1,
      })

      // Only emit a capture when there's something for import-modifiers to do
      // (sizes or toppings). Plain items are fully handled by the menu writer.
      if (modifier_groups.length > 0) {
        captured_items.push({
          item_name: name,
          category: categoryName,
          image_url: null,
          source_url: 'chownow',
          captured_at: new Date().toISOString(),
          modifier_groups,
        })
      }
    }

    if (items.length > 0) {
      categories.push({ name: categoryName, sort_order: categories.length + 1, items })
    }
  }

  return {
    menu: { source_url: 'chownow', categories },
    captured_items,
    warnings,
  }
}
