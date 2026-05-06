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
const HYDRATION_DELAY_MS = 400 // wait for the modal to fully render
const DEDUP_WINDOW_MS = 5000 // don't re-capture the same item this fast

let capturing = true // default ON until popup wires the flag
let lastCaptureSignature = null
let lastCaptureTime = 0

// Read initial capture state.
chrome.storage.local.get([CAPTURING_FLAG]).then((data) => {
  if (CAPTURING_FLAG in data) capturing = !!data[CAPTURING_FLAG]
})

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

    const sig = `${data.item_name}:${data.modifier_groups.length}`
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

function extractItemData(modalRoot) {
  const itemName = (modalRoot.getAttribute('aria-label') || '').trim()
  if (!itemName) {
    console.warn('[DB-Capture] modal has no aria-label — skipping')
    return null
  }

  const sizeNameEls = Array.from(
    modalRoot.querySelectorAll('[data-name="productModal.option"]')
  )
  const toppingNameEls = Array.from(
    modalRoot.querySelectorAll('[data-name="productModal.topping.name"]')
  )
  const optionEls = [...sizeNameEls, ...toppingNameEls]

  if (optionEls.length === 0) {
    return {
      item_name: itemName,
      source_url: window.location.href,
      captured_at: new Date().toISOString(),
      modifier_groups: [],
    }
  }

  // Group options by their nearest ancestor that contains a
  // topping-select-label hint. Each modifier group ships one such
  // hint, so the smallest containing ancestor is the group root.
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
    source_url: window.location.href,
    captured_at: new Date().toISOString(),
    modifier_groups,
  }
}

function findGroupContainer(optionEl, modalRoot) {
  let cursor = optionEl.parentElement
  while (cursor && cursor !== modalRoot) {
    if (cursor.querySelector('[data-name="topping-select-label"]')) return cursor
    cursor = cursor.parentElement
  }
  return null
}

function findSelectableAncestor(optionEl) {
  let cursor = optionEl.parentElement
  while (cursor) {
    const role = cursor.getAttribute && cursor.getAttribute('role')
    if (role === 'radio' || role === 'checkbox') return cursor
    cursor = cursor.parentElement
  }
  return null
}

function extractGroup(container, optionEls) {
  const hintEl = container.querySelector('[data-name="topping-select-label"]')
  const hintText = hintEl ? (hintEl.textContent || '').trim() : ''

  // Group label — the previous sibling of the hint (skipping option/
  // topping wrappers). On Slice this is a sibling div with the visible
  // header text like "Choose an option" or "Add Toppings".
  let label = '(unnamed group)'
  if (hintEl) {
    let prev = hintEl.previousElementSibling
    while (prev) {
      const text = (prev.textContent || '').trim()
      const dn = prev.getAttribute('data-name') || ''
      if (text && !/option|topping/.test(dn)) {
        label = text
        break
      }
      prev = prev.previousElementSibling
    }
  }

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
    const m = hintText.match(/(?:up to|select)\s*(\d+)/i)
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

// ────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────

async function saveCapture(data) {
  const stored = await chrome.storage.local.get([STORAGE_KEY])
  const existing = stored[STORAGE_KEY] || []

  // De-dup by item name within the buffer — last write wins so the
  // user can re-open an item to refresh its capture.
  const filtered = existing.filter((x) => x.item_name !== data.item_name)
  filtered.push(data)

  await chrome.storage.local.set({ [STORAGE_KEY]: filtered })
  console.log('[DB-Capture] captured:', data.item_name, '(' + data.modifier_groups.length + ' groups)')
}
