// DirectBite Modifier Capture — content script
// Runs on slicelife.com pages. Watches the document for an item
// modifier modal to appear, extracts what it can, and stores the
// result in chrome.storage.local for the popup to flush to the
// DirectBite admin API.
//
// Slice's class names are obfuscated CSS-module hashes, so detection
// and extraction rely on structural + ARIA + text signals, not class
// matching.

const STORAGE_KEY = 'directbite_captured_items'
const CAPTURING_FLAG = 'directbite_capturing'
const SCHEMA_KEY = 'directbite_capture_schema'
const SCHEMA_VERSION = 2 // v2 = captures include `category` field; v1 buffers wiped
const DEBUG_WINDOW_KEY = '__dbCapture'
const HYDRATION_DELAY_MS = 400 // wait for the modal to fully render
const DEDUP_WINDOW_MS = 5000 // don't re-capture the same item this fast

// Slice marks each menu category section with data-name="...-category"
// (e.g., "menu-page-category", "house-favorites-category"). The visible
// <h2> inside that section is the category name.
const CATEGORY_DATA_NAME_RE = /-category$/

let capturing = true // default ON until popup wires the flag
let lastCaptureSignature = null
let lastCaptureTime = 0
let currentCategory = null // most recent category section the user clicked into

// Read initial capture state and migrate buffer if needed. v1 captures
// have no `category` field — wipe on first load of v2 so we don't ship
// half-attributed captures to the server.
chrome.storage.local.get([CAPTURING_FLAG, SCHEMA_KEY]).then((data) => {
  if (CAPTURING_FLAG in data) capturing = !!data[CAPTURING_FLAG]
  if (data[SCHEMA_KEY] !== SCHEMA_VERSION) {
    chrome.storage.local.set({
      [STORAGE_KEY]: [],
      [SCHEMA_KEY]: SCHEMA_VERSION,
    })
    console.log('[DB-Capture] schema migrated → buffer cleared')
  }
})

// Track the category the user last clicked into. Capture-phase listener
// at document level runs before any Slice handlers, so currentCategory
// is set synchronously before the modal mutation fires.
document.addEventListener('click', (e) => {
  const path = e.composedPath ? e.composedPath() : []
  for (const el of path) {
    if (!el || !el.getAttribute) continue
    const dn = el.getAttribute('data-name') || ''
    if (!CATEGORY_DATA_NAME_RE.test(dn)) continue
    const heading = el.querySelector('h1, h2, h3, h4')
    if (!heading) continue
    const text = (heading.textContent || '').trim()
    if (text) currentCategory = text
    break
  }
}, true)

// Respond to popup toggle.
chrome.storage.onChanged.addListener((changes) => {
  if (CAPTURING_FLAG in changes) {
    capturing = !!changes[CAPTURING_FLAG].newValue
    console.log('[DB-Capture] capturing =', capturing)
  }
})

// Modal detection: any node added that contains an "Add to order/
// cart/bag" button is treated as a candidate item modal. We then
// climb to the closest dialog ancestor before extracting.
const observer = new MutationObserver((mutations) => {
  if (!capturing) return
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      maybeCaptureFrom(node)
    }
  }
})
observer.observe(document.body, { childList: true, subtree: true })

function maybeCaptureFrom(rootNode) {
  if (!rootNode.querySelectorAll) return
  // Cheap check first — bail fast on unrelated mutations.
  const buttons = rootNode.querySelectorAll('button')
  let isModal = false
  for (const btn of buttons) {
    if (/add to (order|cart|bag)/i.test(btn.textContent || '')) {
      isModal = true
      break
    }
  }
  if (!isModal) return

  const modalRoot = findModalRoot(rootNode)
  if (!modalRoot) return

  // Wait briefly for the modal contents to hydrate before extracting
  // — Slice's React tree renders inputs and price text after the
  // outer dialog frame.
  setTimeout(() => {
    const data = extractItemData(modalRoot)
    if (!data) return

    const sig = `${data.item_name}::${data.category || ''}::${data.modifier_groups.length}`
    const now = Date.now()
    if (sig === lastCaptureSignature && now - lastCaptureTime < DEDUP_WINDOW_MS) return
    lastCaptureSignature = sig
    lastCaptureTime = now

    saveCapture(data)
  }, HYDRATION_DELAY_MS)
}

function findModalRoot(node) {
  let cursor = node
  while (cursor && cursor !== document.body) {
    if (cursor.getAttribute) {
      const role = cursor.getAttribute('role')
      const ariaModal = cursor.getAttribute('aria-modal')
      if (role === 'dialog' || ariaModal === 'true') return cursor
    }
    cursor = cursor.parentElement
  }
  return node
}

// ────────────────────────────────────────────────────────────────────
// Extraction
// ────────────────────────────────────────────────────────────────────

// Slice ships stable data-name attributes for modifier elements:
//   [data-name="productModal.option"]            — size option (name + nested price)
//   [data-name="productModal.option.price"]      — size option price
//   [data-name="productModal.topping.name"]      — topping name
//   [data-name="productModal.topping.price"]     — topping price
//   [data-name="topping-select-label"]           — group hint ("Required, select only one")
// Class names are obfuscated CSS-module hashes — we don't target them.

// Reject aria-labels and headings that look like internal/technical
// container names rather than the actual menu-item title.
const TECHNICAL_NAME_RE = /productmodal|^container$|^dialog$|^modal/i

function extractItemName(modalRoot) {
  // 1. aria-label on the dialog root, if it's not technical.
  const aria = (modalRoot.getAttribute('aria-label') || '').trim()
  if (aria && !TECHNICAL_NAME_RE.test(aria)) return aria

  // 2. aria-labelledby pointing to a heading-like element.
  const labelledBy = modalRoot.getAttribute('aria-labelledby')
  if (labelledBy) {
    const target =
      modalRoot.querySelector(`#${CSS.escape(labelledBy)}`) ||
      document.getElementById(labelledBy)
    if (target) {
      const text = (target.textContent || '').trim()
      if (text && !TECHNICAL_NAME_RE.test(text)) return text
    }
  }

  // 3. First heading inside the modal.
  const heading = modalRoot.querySelector('h1, h2, h3, [role="heading"]')
  if (heading) {
    const text = (heading.textContent || '').trim()
    if (text && !TECHNICAL_NAME_RE.test(text)) return text
  }

  // 4. Any non-technical aria-label inside the modal.
  for (const el of modalRoot.querySelectorAll('[aria-label]')) {
    const a = (el.getAttribute('aria-label') || '').trim()
    if (a && !TECHNICAL_NAME_RE.test(a) && !ICON_LABEL_RE.test(a)) return a
  }

  return null
}

function extractItemData(modalRoot) {
  const itemName = extractItemName(modalRoot)
  if (!itemName) {
    console.warn('[DB-Capture] could not resolve item name — skipping')
    return null
  }

  const sizeNameEls = Array.from(
    modalRoot.querySelectorAll('[data-name="productModal.option"]')
  )
  const toppingNameEls = Array.from(
    modalRoot.querySelectorAll('[data-name="productModal.topping.name"]')
  )

  // "Bare role" options — role=radio/checkbox elements with no
  // productModal.* inner data-name. Slice uses this for "Add Extra"
  // / "Make It" style groups where name + price live as plain text
  // inside the role container, alongside an unchecked/checked
  // placeholder div.
  const bareRoleEls = Array.from(
    modalRoot.querySelectorAll('[role="radio"], [role="checkbox"]')
  ).filter(
    (el) =>
      !el.querySelector(
        '[data-name="productModal.option"], [data-name="productModal.topping.name"]'
      )
  )

  const optionEls = [...sizeNameEls, ...toppingNameEls, ...bareRoleEls]

  if (optionEls.length === 0) {
    return {
      item_name: itemName,
      category: currentCategory,
      source_url: window.location.href,
      captured_at: new Date().toISOString(),
      modifier_groups: [],
    }
  }

  const groupsByContainer = new Map()
  for (const optEl of optionEls) {
    const container = findGroupContainer(optEl, modalRoot)
    if (!container) continue
    if (!groupsByContainer.has(container)) groupsByContainer.set(container, [])
    groupsByContainer.get(container).push(optEl)
  }

  const modifier_groups = []
  for (const [container, els] of groupsByContainer) {
    const group = extractGroup(container, els)
    if (group) modifier_groups.push(group)
  }

  return {
    item_name: itemName,
    category: currentCategory,
    source_url: window.location.href,
    captured_at: new Date().toISOString(),
    modifier_groups,
  }
}

// Group container detection.
// Walk up from the option to the smallest ancestor whose textContent
// shows a Slice group-header signal — either an instructions subtitle
// ("Select only one" / "Select up to N") or a label starting with the
// group's action verb ("Choose / Add / Pick / Select / Make ...").
//
// We previously stopped at any ancestor with a non-modifier short text
// descendant. That was too lenient: when an inner group wrapper had its
// label inside an element findLabelText skipped (e.g., a button-wrapped
// accordion header), the walk continued up to a shared ancestor and
// merged distinct groups into one bucket. The header-signal predicate
// is specific enough to identify the correct wrapper even when its
// label is otherwise unreachable.
//
// "Select only one" / "Select up to N" is Slice's standard subtitle on
// every modifier group (including the size hint via topping-select-label),
// so it's the strongest signal. The label-prefix fallback catches any
// group whose subtitle phrasing differs.
const GROUP_HEADER_SUBTITLE_RE = /select\s+(?:only\s+one|up\s+to\s+\d+)/i
const GROUP_HEADER_LABEL_RE = /^(choose|add|pick|select|make)\b/i

function hasGroupHeaderSignal(container) {
  const text = container.textContent || ''
  if (GROUP_HEADER_SUBTITLE_RE.test(text)) return true
  const label = findLabelText(container)
  if (label && GROUP_HEADER_LABEL_RE.test(label)) return true
  return false
}

function findGroupContainer(optionEl, modalRoot) {
  // Prefer ancestors that match the group-header signal.
  let cursor = optionEl.parentElement
  while (cursor && cursor !== modalRoot) {
    if (hasGroupHeaderSignal(cursor)) return cursor
    cursor = cursor.parentElement
  }
  // Fallback: any ancestor with a label-bearing descendant. Only reached
  // if no group-header signal exists anywhere up the chain (rare).
  cursor = optionEl.parentElement
  while (cursor && cursor !== modalRoot) {
    if (findLabelText(cursor) !== null) return cursor
    cursor = cursor.parentElement
  }
  return null
}

function directText(el) {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent || '')
    .join('')
    .trim()
}

function findSelectableAncestor(optionEl) {
  // Start from optionEl itself — for "bare role" options the element
  // we collected IS the role=radio/checkbox container.
  let cursor = optionEl
  while (cursor) {
    const role = cursor.getAttribute && cursor.getAttribute('role')
    if (role === 'radio' || role === 'checkbox') return cursor
    cursor = cursor.parentElement
  }
  return null
}

// Depth-first walk of `container` for the first label-like text:
// short direct text, outside any modifier subtree (option / topping /
// topping-select-label / role=radio / role=checkbox). Returns the
// string or null. Used by findGroupContainer to decide whether the
// cluster needs expanding, and by findGroupLabel for final extraction.
// Known SVG/icon labels that surface from close buttons even when
// the subtree skip misses them — usually because Slice nests the
// title element in something we don't recognize as a button.
const ICON_LABEL_RE = /^(circle\s*x|x|close|menu)$/i

function findLabelText(container) {
  function visit(el) {
    if (!el) return null
    const tag = (el.tagName || '').toLowerCase()
    if (tag === 'svg' || tag === 'button') return null
    const role = (el.getAttribute && el.getAttribute('role')) || ''
    if (role === 'radio' || role === 'checkbox' || role === 'button') return null
    const dn = (el.getAttribute && el.getAttribute('data-name')) || ''
    if (/option|topping/.test(dn)) return null

    const ownText = directText(el)
    if (ownText && ownText.length < 50) {
      // Reject obvious icon labels that may slip past the subtree
      // skip on edge-case button structures.
      if (ICON_LABEL_RE.test(ownText.trim())) return null
      // Belt: walk ancestors up to (but not including) the search
      // root; if any are svg/button/role=button, reject.
      let p = el.parentElement
      while (p && p !== container) {
        const pTag = (p.tagName || '').toLowerCase()
        const pRole = (p.getAttribute && p.getAttribute('role')) || ''
        if (pTag === 'svg' || pTag === 'button' || pRole === 'button') return null
        p = p.parentElement
      }
      return ownText.split('\n')[0].trim()
    }

    for (const child of el.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }

  for (const child of container.children) {
    const found = visit(child)
    if (found) return found
  }
  return null
}

function findGroupLabel(container, optionEls) {
  return findLabelText(container) || '(unnamed group)'
}

function extractGroup(container, optionEls) {
  const hintEl = container.querySelector('[data-name="topping-select-label"]')
  const hintText = hintEl ? (hintEl.textContent || '').trim() : ''

  const label = findGroupLabel(container, optionEls)

  // Selection type — peek at the first option's selectable ancestor.
  // role="radio" → single, role="checkbox" → multi.
  let selection_type = 'multi'
  const firstSelectable = optionEls[0] && findSelectableAncestor(optionEls[0])
  if (firstSelectable && firstSelectable.getAttribute('role') === 'radio') {
    selection_type = 'single'
  }

  const required = /required/i.test(hintText)

  let max_selections = null
  if (selection_type === 'single') {
    max_selections = 1
  } else {
    // Multi-select hint patterns: "Up to N", "Select up to N",
    // "Pick up to N", "Choose N", "Select N", etc.
    const m = hintText.match(/(?:up to|pick|choose|select)\s+(?:up to\s+)?(\d+)/i)
    if (m) max_selections = parseInt(m[1], 10)
  }

  const options = []
  for (const optEl of optionEls) {
    const option = extractOption(optEl)
    if (option) options.push(option)
  }

  return { label, selection_type, required, max_selections, options }
}

function extractOption(optEl) {
  // Bare role options: the option element IS the role=radio/checkbox
  // container, with no productModal.* descendant. Slice uses this
  // for "Add Extra" / "Make It" groups.
  const role = optEl.getAttribute('role')
  if (role === 'radio' || role === 'checkbox') {
    return extractBareRoleOption(optEl)
  }

  const dn = optEl.getAttribute('data-name')
  const isSize = dn === 'productModal.option'

  let priceText = ''
  let name = ''

  if (isSize) {
    // Size: productModal.option contains both name and a nested
    // productModal.option.price span. Strip the price text from the
    // full text to get the name.
    const priceEl = optEl.querySelector('[data-name="productModal.option.price"]')
    priceText = priceEl ? (priceEl.textContent || '').trim() : ''
    const fullText = (optEl.textContent || '').trim()
    name = priceText ? fullText.replace(priceText, '').trim() : fullText
  } else {
    // Topping: productModal.topping.name is just the name; price is a
    // sibling productModal.topping.price inside the same role=checkbox.
    name = (optEl.textContent || '').trim()
    const selectable = findSelectableAncestor(optEl)
    if (selectable) {
      const priceEl = selectable.querySelector('[data-name="productModal.topping.price"]')
      priceText = priceEl ? (priceEl.textContent || '').trim() : ''
    }
  }

  name = name.replace(/\s+/g, ' ').trim()
  if (!name) return null

  const priceMatch = priceText.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
  const price = priceMatch ? Number(priceMatch[1]) : 0

  const selectable = findSelectableAncestor(optEl)
  const is_default = selectable?.getAttribute('aria-checked') === 'true'

  return { name, price, is_default }
}

// "Bare role" option extractor — for role=radio/checkbox containers
// without a productModal.* inner data-name. Name + price live as
// plain text alongside an unchecked/checked indicator subtree we
// need to skip.
function extractBareRoleOption(roleEl) {
  function gather(el, parts) {
    if (!el) return
    const dn = (el.getAttribute && el.getAttribute('data-name')) || ''
    // Skip the unchecked/checked state indicator subtree.
    if (/^(un)?checked$/i.test(dn)) return
    const direct = directText(el)
    if (direct) parts.push(direct)
    for (const child of el.children) gather(child, parts)
  }

  const parts = []
  gather(roleEl, parts)
  const fullText = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!fullText) return null

  const priceMatch = fullText.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
  const price = priceMatch ? Number(priceMatch[1]) : 0

  const name = fullText
    .replace(/\+?\s*\$\s*\d+(?:\.\d{1,2})?\s*\+?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null

  const is_default = roleEl.getAttribute('aria-checked') === 'true'

  return { name, price, is_default }
}

// ────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────

async function saveCapture(data) {
  const stored = await chrome.storage.local.get([STORAGE_KEY])
  const existing = stored[STORAGE_KEY] || []

  // De-dup by (item_name, category). Re-capturing the same item in the
  // same category replaces; capturing the same name in a different
  // category creates a new entry. Empty/null categories are equivalent.
  const cat = data.category || ''
  const filtered = existing.filter(
    (x) => x.item_name !== data.item_name || (x.category || '') !== cat
  )
  filtered.push(data)

  await chrome.storage.local.set({ [STORAGE_KEY]: filtered })
  // Mirror to window so the slicelife.com page console can inspect
  // captures without needing extension-context devtools.
  window[DEBUG_WINDOW_KEY] = filtered
  console.log(
    '[DB-Capture] captured:',
    data.item_name,
    `[${data.category || 'no category'}]`,
    '(' + data.modifier_groups.length + ' groups)'
  )
  console.log('[DB-Capture] window.__dbCapture has', filtered.length, 'items')
}
