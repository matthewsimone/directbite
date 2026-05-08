import { createClient } from '@supabase/supabase-js'

const RATE_LIMIT_WINDOW_MS = 30 * 1000
const lastImportByAdmin = new Map()

function isPizzaCategory(name) {
  return /pizza|pie|stromboli/i.test(name || '')
}

function roundCents(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}

// Deterministic signature of a topping group's contents, used to decide
// whether a captured group is "the same" as an existing one. Sort by
// name so order doesn't matter; normalize fields so trivial differences
// (case, whitespace, missing booleans) don't produce false misses.
function toppingsSig(toppings) {
  const norm = (toppings || []).map((t) => ({
    n: (t.name || '').toLowerCase().trim(),
    p: roundCents(t.price),
    d: !!t.is_default,
  }))
  norm.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
  return JSON.stringify(norm)
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  if (/^chrome-extension:\/\//.test(origin) || /^https:\/\/(www\.)?directbite\.co$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const apiKey = process.env.SUPABASE_QR_API_KEY
  if (!supabaseUrl || !apiKey) {
    console.error('[import-modifiers] Missing env: VITE_SUPABASE_URL or SUPABASE_QR_API_KEY')
    return res.status(500).json({ error: 'Server not configured' })
  }

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  const supabase = createClient(supabaseUrl, apiKey)
  const { data: userResult, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !userResult?.user?.email) {
    return res.status(401).json({ error: 'invalid token' })
  }
  const adminEmail = userResult.user.email

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('email')
    .eq('email', adminEmail)
    .maybeSingle()
  if (!adminRow) return res.status(403).json({ error: 'forbidden' })

  const now = Date.now()
  const last = lastImportByAdmin.get(adminEmail)
  if (last && now - last < RATE_LIMIT_WINDOW_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - last)) / 1000)
    return res.status(429).json({
      error: `Please wait ${waitSec} seconds before importing again.`,
    })
  }
  lastImportByAdmin.set(adminEmail, now)

  const body = req.body || {}
  const restaurantId = typeof body.restaurant_id === 'string' ? body.restaurant_id : ''
  const capturedItems = Array.isArray(body.captured_items) ? body.captured_items : null
  if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' })
  if (!capturedItems) return res.status(400).json({ error: 'captured_items array required' })
  if (capturedItems.length === 0) {
    return res.status(400).json({ error: 'captured_items is empty' })
  }

  // Pre-fetch menu — we lookup items by lowercased name within this restaurant.
  // A single item name can map to multiple menu_items rows when the static
  // importer creates one row per category appearance (e.g., "Plain Pizza" in
  // both "Pizza" and "House Favorites"). All matching rows get the same
  // modifier set applied below.
  const { data: menuItems, error: menuErr } = await supabase
    .from('menu_items')
    .select('id, name, category_id, menu_categories(name)')
    .eq('restaurant_id', restaurantId)
  if (menuErr) {
    return res.status(500).json({ error: `Failed to load menu: ${menuErr.message}` })
  }
  const menuItemsByName = new Map()
  for (const m of menuItems || []) {
    const key = (m.name || '').toLowerCase().trim()
    if (!menuItemsByName.has(key)) menuItemsByName.set(key, [])
    menuItemsByName.get(key).push(m)
  }

  let itemsProcessed = 0
  const itemsSkipped = []
  let sizesUpdated = 0
  let sizesRenamed = 0
  let toppingGroupsCreated = 0
  let groupsReused = 0
  let linksReplaced = 0
  let toppingsCreated = 0
  const errors = []

  for (const captured of capturedItems) {
    const itemName = (captured.item_name || '').trim()
    if (!itemName) continue

    const matches = menuItemsByName.get(itemName.toLowerCase()) || []
    if (matches.length === 0) {
      itemsSkipped.push(itemName)
      continue
    }
    itemsProcessed += 1

    // Any-match placement type: if any duplicate sits in a pizza-like
    // category, treat the whole capture as pizza. Slice presents the same
    // modifiers regardless of which category the customer clicked from, so
    // duplicates spanning categories (e.g., "Plain Pizza" in both "Pizza"
    // and "House Favorites") still get pizza-style placement.
    const placementTypeForToppings = matches.some(
      (m) => isPizzaCategory(m.menu_categories?.name || '')
    ) ? 'pizza' : 'addon'

    // Per-item replace: clear existing item_topping_groups for every
    // matching menu_item before processing this capture's groups.
    let clearFailed = false
    for (const menuItem of matches) {
      const { error: clearErr } = await supabase
        .from('item_topping_groups')
        .delete()
        .eq('item_id', menuItem.id)
      if (clearErr) {
        errors.push(`Clear links for "${itemName}" (${menuItem.id}): ${clearErr.message}`)
        clearFailed = true
        break
      }
      linksReplaced += 1
    }
    if (clearFailed) continue

    const groups = Array.isArray(captured.modifier_groups) ? captured.modifier_groups : []

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]
      const groupLabel = (group.label || '').trim()
      const options = Array.isArray(group.options) ? group.options : []
      if (options.length === 0) continue

      const isSizeGroup = g === 0 && /^choose\s+an?\s+option$/i.test(groupLabel)

      if (isSizeGroup) {
        // Single-option size: rename the existing item_sizes row so the
        // captured Slice label (e.g., "Slice", "Whole Pie") replaces the
        // empty name written at static-import time. Preserves the row id
        // so historical order_items.item_size_id references stay valid.
        // Applied to each matching duplicate independently.
        if (options.length === 1) {
          const newName = (options[0].name || '').trim()
          if (!newName) continue

          for (const menuItem of matches) {
            const { data: existingSizes, error: fetchErr } = await supabase
              .from('item_sizes')
              .select('id, name')
              .eq('item_id', menuItem.id)
            if (fetchErr) {
              errors.push(`Size lookup for "${itemName}" (${menuItem.id}): ${fetchErr.message}`)
              continue
            }
            if (!existingSizes || existingSizes.length === 0) {
              console.warn(`[modifier-import] no existing size row for item ${menuItem.id} ("${itemName}") — skipping rename`)
              continue
            }
            if (existingSizes.length > 1) {
              console.warn(`[modifier-import] ${existingSizes.length} size rows for item ${menuItem.id} ("${itemName}") — ambiguous, skipping rename`)
              continue
            }

            const existing = existingSizes[0]
            const oldName = existing.name || ''
            const { error: updErr } = await supabase
              .from('item_sizes')
              .update({ name: newName })
              .eq('id', existing.id)
            if (updErr) {
              errors.push(`Size rename for "${itemName}" (${menuItem.id}): ${updErr.message}`)
              continue
            }
            console.log(`[modifier-import] renamed size for item ${menuItem.id}: '${oldName}' -> '${newName}'`)
            sizesRenamed += 1
          }
          continue
        }

        // Multi-option size: replace existing item_sizes if no FK from
        // order_items. Applied per matching menu_item.
        for (const menuItem of matches) {
          const { data: existingSizes } = await supabase
            .from('item_sizes')
            .select('id')
            .eq('item_id', menuItem.id)
          const sizeIds = (existingSizes || []).map((s) => s.id)
          if (sizeIds.length > 0) {
            const { count } = await supabase
              .from('order_items')
              .select('id', { count: 'exact', head: true })
              .in('item_size_id', sizeIds)
            if ((count || 0) > 0) {
              errors.push(
                `Sizes for "${itemName}" (${menuItem.id}) skipped — referenced by ${count} existing order(s)`
              )
              continue
            }
            const { error: delErr } = await supabase
              .from('item_sizes')
              .delete()
              .in('id', sizeIds)
            if (delErr) {
              errors.push(`Sizes for "${itemName}" (${menuItem.id}) delete failed: ${delErr.message}`)
              continue
            }
          }

          let allOk = true
          for (let i = 0; i < options.length; i++) {
            const opt = options[i]
            const { error } = await supabase.from('item_sizes').insert({
              item_id: menuItem.id,
              name: (opt.name || '').trim(),
              price: roundCents(opt.price),
              sort_order: i,
            })
            if (error) {
              errors.push(`Size "${opt.name}" for "${itemName}" (${menuItem.id}): ${error.message}`)
              allOk = false
            }
          }
          if (allOk) sizesUpdated += 1
        }
        continue
      }

      // Topping group — resolve groupId ONCE per captured group, then attach
      // to every matching menu_item.
      const desiredSelectionType = group.selection_type === 'single' ? 'single' : 'unlimited'
      const desiredMaxSelections =
        group.max_selections != null ? Number(group.max_selections) : null

      // Content-signature dedup: a captured group is "the same" as an existing
      // one only if name (case-insensitive), placement_type, selection_type, AND
      // its full topping set (name + price + is_default) all match. This avoids
      // wrong reuse where a "Toppings" pizza group gets bound to a sandwich.
      const capturedSig = toppingsSig(options)

      const { data: candidates } = await supabase
        .from('topping_groups')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .eq('placement_type', placementTypeForToppings)
        .eq('selection_type', desiredSelectionType)
        .ilike('name', groupLabel)

      let groupId = null
      for (const cand of candidates || []) {
        const { data: candToppings, error: candErr } = await supabase
          .from('toppings')
          .select('name, price, is_default')
          .eq('topping_group_id', cand.id)
        if (candErr) {
          console.warn(`[modifier-import] candidate ${cand.id} topping fetch failed:`, candErr.message)
          continue
        }
        if (toppingsSig(candToppings || []) === capturedSig) {
          groupId = cand.id
          groupsReused += 1
          break
        }
      }

      if (!groupId) {
        const { data: insertedGroup, error: insErr } = await supabase
          .from('topping_groups')
          .insert({
            restaurant_id: restaurantId,
            name: groupLabel,
            sort_order: 0,
            placement_type: placementTypeForToppings,
            selection_type: desiredSelectionType,
            required: false, // per spec — defaults handle required-ness
            max_selections:
              desiredSelectionType === 'unlimited' ? null : desiredMaxSelections,
          })
          .select('id')
          .single()
        if (insErr || !insertedGroup) {
          errors.push(
            `Group "${groupLabel}" for "${itemName}": ${insErr?.message || 'insert failed'}`
          )
          continue
        }
        groupId = insertedGroup.id
        toppingGroupsCreated += 1

        // Fresh group → insert all its toppings. No dedup needed.
        for (let i = 0; i < options.length; i++) {
          const opt = options[i]
          const optName = (opt.name || '').trim()
          if (!optName) continue
          const { error: tErr } = await supabase.from('toppings').insert({
            topping_group_id: groupId,
            restaurant_id: restaurantId,
            name: optName,
            price: roundCents(opt.price),
            is_default: !!opt.is_default,
            sort_order: i,
          })
          if (tErr) {
            errors.push(`Topping "${optName}" in "${groupLabel}": ${tErr.message}`)
            continue
          }
          toppingsCreated += 1
        }
      }

      // Link each matching menu_item → group. We cleared all links for these
      // items earlier, so these inserts always create fresh rows. sort_order
      // = capture index preserves Slice's display order.
      for (const menuItem of matches) {
        const { error: linkErr } = await supabase.from('item_topping_groups').insert({
          item_id: menuItem.id,
          topping_group_id: groupId,
          sort_order: g,
        })
        if (linkErr) {
          errors.push(`Link "${itemName}" (${menuItem.id}) → "${groupLabel}": ${linkErr.message}`)
        }
      }
    }
  }

  return res.status(200).json({
    items_processed: itemsProcessed,
    items_skipped: itemsSkipped,
    sizes_updated: sizesUpdated,
    sizes_renamed: sizesRenamed,
    topping_groups_created: toppingGroupsCreated,
    groups_reused: groupsReused,
    links_replaced: linksReplaced,
    toppings_created: toppingsCreated,
    errors,
  })
}
