const STORAGE_KEY = 'directbite_captured_items'
const CAPTURING_FLAG = 'directbite_capturing'
const RESTAURANT_ID_KEY = 'directbite_restaurant_id'
const BEARER_TOKEN_KEY = 'directbite_bearer_token'
const API_URL = 'https://www.directbite.co/api/import-modifiers'

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  toggleBtn: document.getElementById('toggle-btn'),
  restaurantId: document.getElementById('restaurant-id'),
  bearerToken: document.getElementById('bearer-token'),
  sendBtn: document.getElementById('send-btn'),
  clearBtn: document.getElementById('clear-btn'),
  itemsBody: document.getElementById('items-body'),
  itemsHeader: document.getElementById('items-header'),
  message: document.getElementById('message'),
}

let capturing = true
let items = []

async function init() {
  const data = await chrome.storage.local.get([
    STORAGE_KEY, CAPTURING_FLAG, RESTAURANT_ID_KEY, BEARER_TOKEN_KEY,
  ])
  capturing = data[CAPTURING_FLAG] !== false  // default ON
  items = data[STORAGE_KEY] || []
  els.restaurantId.value = data[RESTAURANT_ID_KEY] || ''
  els.bearerToken.value = data[BEARER_TOKEN_KEY] || ''
  render()
}

function render() {
  if (capturing) {
    els.status.classList.add('capturing')
    els.statusText.textContent = `Capturing • ${items.length} item${items.length === 1 ? '' : 's'} captured`
    els.toggleBtn.textContent = 'Stop Capture'
  } else {
    els.status.classList.remove('capturing')
    els.statusText.textContent = `Paused • ${items.length} item${items.length === 1 ? '' : 's'} captured`
    els.toggleBtn.textContent = 'Start Capture'
  }

  els.itemsHeader.textContent = `Captured Items (${items.length})`
  if (items.length === 0) {
    els.itemsBody.innerHTML = '<div class="empty">No items captured yet</div>'
  } else {
    const ul = document.createElement('ul')
    for (const item of items) {
      const li = document.createElement('li')
      li.textContent = item.item_name
      ul.appendChild(li)
    }
    els.itemsBody.replaceChildren(ul)
  }
}

function showMessage(text, kind) {
  els.message.textContent = text
  els.message.className = `message show ${kind}`
}
function hideMessage() { els.message.className = 'message' }

els.toggleBtn.addEventListener('click', async () => {
  capturing = !capturing
  await chrome.storage.local.set({ [CAPTURING_FLAG]: capturing })
  render()
})

els.restaurantId.addEventListener('input', async (e) => {
  await chrome.storage.local.set({ [RESTAURANT_ID_KEY]: e.target.value.trim() })
})

els.bearerToken.addEventListener('input', async (e) => {
  await chrome.storage.local.set({ [BEARER_TOKEN_KEY]: e.target.value.trim() })
})

els.clearBtn.addEventListener('click', async () => {
  if (items.length === 0) return
  if (!confirm(`Clear ${items.length} captured item${items.length === 1 ? '' : 's'}?`)) return
  await chrome.storage.local.set({ [STORAGE_KEY]: [] })
  items = []
  hideMessage()
  render()
})

els.sendBtn.addEventListener('click', async () => {
  hideMessage()
  const restaurantId = els.restaurantId.value.trim()
  const bearerToken = els.bearerToken.value.trim()
  if (!restaurantId) return showMessage('Restaurant ID is required.', 'error')
  if (!bearerToken) return showMessage('Bearer token is required.', 'error')
  if (items.length === 0) return showMessage('No items to send.', 'error')

  els.sendBtn.disabled = true
  els.sendBtn.textContent = 'Sending…'
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        restaurant_id: restaurantId,
        captured_items: items,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      showMessage(`Failed (${res.status}): ${data.error || 'Unknown error'}`, 'error')
      return
    }
    const summary = [
      `${data.items_processed || 0} processed`,
      `${data.sizes_updated || 0} sizes`,
      `${data.topping_groups_created || 0} groups`,
      `${data.toppings_created || 0} toppings`,
    ]
    if (data.items_skipped?.length) summary.push(`${data.items_skipped.length} skipped`)
    if (data.errors?.length) summary.push(`${data.errors.length} errors`)
    showMessage(summary.join(' · '), 'success')
  } catch (err) {
    showMessage(`Network error: ${err.message}`, 'error')
  } finally {
    els.sendBtn.disabled = false
    els.sendBtn.textContent = 'Send to DirectBite'
  }
})

// Live update while popup is open.
chrome.storage.onChanged.addListener((changes) => {
  if (STORAGE_KEY in changes) { items = changes[STORAGE_KEY].newValue || []; render() }
  if (CAPTURING_FLAG in changes) {
    capturing = changes[CAPTURING_FLAG].newValue !== false
    render()
  }
})

init()
