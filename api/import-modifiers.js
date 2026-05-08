import { createClient } from '@supabase/supabase-js'

const RATE_LIMIT_WINDOW_MS = 30 * 1000
const lastImportByAdmin = new Map()

function isPizzaCategory(name) {
  return /pizza|pie|stromboli/i.test(name || '')
}

function roundCents(v) {
  return Math.round((Number(v) || 0) * 100) / 100
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
  const { data: menuItems, error: menuErr } = await supabase
    .from('menu_items')
    .select('id, name, category_id, menu_categories(name)')
    .eq('restaurant_id', restaurantId)
  if (menuErr) {
    return res.status(500).json({ error: `Failed to load menu: ${menuErr.message}` })
  }
  const menuByName = new Map()
  for (const m of menuItems || []) {
    menuByName.set((m.name || '').toLowerCase().trim(), m)
  }

  let itemsProcessed = 0
  const itemsSkipped = []
  let sizesUpdated = 0
  let sizesRenamed = 0
  let toppingGroupsCreated = 0
  let toppingsCreated = 0
  const errors = []

  for (const captured of capturedItems) {
    const itemName = (captured.item_name || '').trim()
    if (!itemName) continue

    const menuItem = menuByName.get(itemName.toLowerCase())
    if (!menuItem) {
      itemsSkipped.push(itemName)
      continue
    }
    itemsProcessed += 1

    const categoryName = menuItem.menu_categories?.name || ''
    const placementTypeForToppings = isPizzaCategory(categoryName) ? 'pizza' : 'addon'

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
        if (options.length === 1) {
          const newName = (options[0].name || '').trim()
          if (!newName) continue

          const { data: existingSizes, error: fetchErr } = await supabase
            .from('item_sizes')
            .select('id, name')
            .eq('item_id', menuItem.id)
          if (fetchErr) {
            errors.push(`Size lookup for "${itemName}": ${fetchErr.message}`)
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
            errors.push(`Size rename for "${itemName}": ${updErr.message}`)
            continue
          }
          console.log(`[modifier-import] renamed size for item ${menuItem.id}: '${oldName}' -> '${newName}'`)
          sizesRenamed += 1
          continue
        }

        // Multi-option size: replace existing item_sizes if no FK from order_items.
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
              `Sizes for "${itemName}" skipped — referenced by ${count} existing order(s)`
            )
            continue
          }
          const { error: delErr } = await supabase
            .from('item_sizes')
            .delete()
            .in('id', sizeIds)
          if (delErr) {
            errors.push(`Sizes for "${itemName}" delete failed: ${delErr.message}`)
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
            errors.push(`Size "${opt.name}" for "${itemName}": ${error.message}`)
            allOk = false
          }
        }
        if (allOk) sizesUpdated += 1
        continue
      }

      // Topping group
      const desiredSelectionType = group.selection_type === 'single' ? 'single' : 'unlimited'
      const desiredMaxSelections =
        group.max_selections != null ? Number(group.max_selections) : null

      // Reuse if a group with this name already exists on the restaurant.
      // Don't update existing — admin edits are preserved.
      const { data: existingGroups } = await supabase
        .from('topping_groups')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .ilike('name', groupLabel)

      let groupId
      if (existingGroups && existingGroups.length > 0) {
        groupId = existingGroups[0].id
      } else {
        const { data: insertedGroup, error } = await supabase
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
        if (error || !insertedGroup) {
          errors.push(
            `Group "${groupLabel}" for "${itemName}": ${error?.message || 'insert failed'}`
          )
          continue
        }
        groupId = insertedGroup.id
        toppingGroupsCreated += 1
      }

      // Toppings — dedup by lowercased name within the group.
      const { data: existingToppings } = await supabase
        .from('toppings')
        .select('name')
        .eq('topping_group_id', groupId)
      const existingNames = new Set(
        (existingToppings || []).map((t) => (t.name || '').toLowerCase().trim())
      )

      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        const optName = (opt.name || '').trim()
        if (!optName) continue
        if (existingNames.has(optName.toLowerCase())) continue
        const { error } = await supabase.from('toppings').insert({
          topping_group_id: groupId,
          restaurant_id: restaurantId,
          name: optName,
          price: roundCents(opt.price),
          is_default: !!opt.is_default,
          sort_order: i,
        })
        if (error) {
          errors.push(`Topping "${optName}" in "${groupLabel}": ${error.message}`)
          continue
        }
        toppingsCreated += 1
        existingNames.add(optName.toLowerCase())
      }

      // Link item → group (idempotent).
      const { data: existingLinks } = await supabase
        .from('item_topping_groups')
        .select('id')
        .eq('item_id', menuItem.id)
        .eq('topping_group_id', groupId)
        .limit(1)
      if (!existingLinks || existingLinks.length === 0) {
        const { error: linkErr } = await supabase.from('item_topping_groups').insert({
          item_id: menuItem.id,
          topping_group_id: groupId,
        })
        if (linkErr) {
          errors.push(`Link "${itemName}" → "${groupLabel}": ${linkErr.message}`)
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
    toppings_created: toppingsCreated,
    errors,
  })
}
