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

function extractItemData(modalRoot) {
  // Item name — first prominent heading. The modal's outer header
  // typically holds the item name; "CHOOSE AN OPTION" / similar
  // group labels come later as h2/h3 inside the body.
  const heading =
    modalRoot.querySelector('h1') ||
    modalRoot.querySelector('h2') ||
    modalRoot.querySelector('[role="heading"]')
  const itemName = heading ? heading.textContent.trim() : null
  if (!itemName) {
    // ──────────────── DIAGNOSTIC: dump modal structure ────────────────
    console.warn('[DB-Capture] modal had no heading — dumping structure for selector tuning')

    console.log(
      '[DB-Capture] modal outerHTML (first 5000)',
      (modalRoot.outerHTML || '').slice(0, 5000)
    )

    console.log(
      '[DB-Capture] modal textContent head (200)',
      (modalRoot.textContent || '').trim().slice(0, 200)
    )

    const paragraphs = []
    modalRoot.querySelectorAll('p').forEach((el) => {
      const text = (el.textContent || '').trim()
      if (!text) return
      paragraphs.push({
        text: text.slice(0, 100),
        class: (el.getAttribute('class') || '').slice(0, 50),
      })
    })
    console.log('[DB-Capture] <p> elements', paragraphs)

    const shortDivs = []
    modalRoot.querySelectorAll('div').forEach((el) => {
      // Only count direct text — exclude divs whose text comes entirely
      // from descendants (those are layout containers, not titles).
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '')
        .join('')
        .trim()
      if (!ownText || ownText.length >= 100) return
      shortDivs.push({
        text: ownText.slice(0, 100),
        class: (el.getAttribute('class') || '').slice(0, 50),
      })
    })
    console.log('[DB-Capture] <div> with own text < 100 chars', shortDivs.slice(0, 30))

    const ariaCandidates = []
    modalRoot.querySelectorAll('[role="heading"], [aria-label]').forEach((el) => {
      ariaCandidates.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        text: (el.textContent || '').trim().slice(0, 100),
      })
    })
    console.log('[DB-Capture] role="heading" / [aria-label] elements', ariaCandidates)
    // ──────────────────── end diagnostic ────────────────────
    return null
  }

  // Modifier inputs — radio + checkbox + ARIA equivalents in case
  // Slice uses div-based custom controls.
  const inputs = Array.from(
    modalRoot.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
    )
  )
  if (inputs.length === 0) {
    return {
      item_name: itemName,
      source_url: window.location.href,
      captured_at: new Date().toISOString(),
      modifier_groups: [],
    }
  }

  // Group inputs by their nearest semantic group container.
  const groupsByContainer = new Map()
  for (const input of inputs) {
    const container = findGroupContainer(input, modalRoot)
    if (!groupsByContainer.has(container)) groupsByContainer.set(container, [])
    groupsByContainer.get(container).push(input)
  }

  const modifier_groups = []
  for (const [container, groupInputs] of groupsByContainer) {
    const group = extractGroup(container, groupInputs)
    if (group) modifier_groups.push(group)
  }

  return {
    item_name: itemName,
    source_url: window.location.href,
    captured_at: new Date().toISOString(),
    modifier_groups,
  }
}

function findGroupContainer(input, modalRoot) {
  let cursor = input.parentElement
  while (cursor && cursor !== modalRoot) {
    if (cursor.tagName === 'FIELDSET') return cursor
    const role = cursor.getAttribute && cursor.getAttribute('role')
    if (role === 'group' || role === 'radiogroup') return cursor
    cursor = cursor.parentElement
  }
  // Fallback: two levels up — typically the row's container is the
  // option, the next level is the group.
  return input.parentElement?.parentElement || input.parentElement || modalRoot
}

function extractGroup(container, inputs) {
  // Group label — first heading or legend within the container.
  const labelEl =
    container.querySelector('legend') ||
    container.querySelector('h2, h3, h4') ||
    container.querySelector('[role="heading"]')
  const label = labelEl ? labelEl.textContent.trim().split('\n')[0] : '(unnamed group)'

  // Selection type — radios = single, anything else = multi.
  const allRadios = inputs.every((i) => {
    const t = i.type || i.getAttribute('role')
    return t === 'radio'
  })
  const selection_type = allRadios ? 'single' : 'multi'

  // Required — heuristic. "Required" badge or asterisk near the label.
  const containerHead = (container.textContent || '').slice(0, 200)
  const required = /required|\*/i.test(containerHead)

  // Max selections — "Choose up to N" / "Pick up to N" / "Up to N".
  const maxMatch = (container.textContent || '').match(
    /(?:choose|select|pick|up to)\s*(\d+)/i
  )
  const max_selections =
    selection_type === 'single' ? 1 : maxMatch ? parseInt(maxMatch[1], 10) : null

  const options = []
  for (const input of inputs) {
    const option = extractOption(input)
    if (option) options.push(option)
  }

  return { label, selection_type, required, max_selections, options }
}

function extractOption(input) {
  const row =
    input.closest('label') ||
    input.parentElement?.closest('li, [role="option"]') ||
    input.parentElement
  if (!row) return null

  const text = (row.textContent || '').trim()
  if (!text) return null

  const priceMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
  const price = priceMatch ? Number(priceMatch[1]) : 0

  // Strip the price + optional leading + sign from the row text to
  // leave the option name. e.g. "+ $3.00 Pepperoni" → "Pepperoni".
  const name = text
    .replace(/\+?\s*\$\s*\d+(?:\.\d{1,2})?\s*\+?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null

  const is_default =
    input.checked === true || input.getAttribute('aria-checked') === 'true'

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
  console.log(
    '[DB-Capture] captured:',
    data.item_name,
    `(${data.modifier_groups.length} groups, ${data.modifier_groups.reduce(
      (s, g) => s + g.options.length, 0
    )} options)`
  )
}
