// Epson ePOS SDK direct printing for DirectBite
// Requires epos-2.27.0.js loaded via <script> tag
// TM-M30 80mm paper = 48 characters wide

import { formatPhone } from './format'

const W = 48
const DW = W / 2 // double-width chars per line at 2x size = 24

// Serialize every print job — auto-print, retry, and manual reprint all funnel
// onto this one FIFO chain. The shared TM-M30 accepts a single ePOS connection
// at a time; concurrent connects collide and surface as "connection timed out".
// Each job waits for the previous one to settle before opening its connection.
let printChain = Promise.resolve()

// Decode the ePOS ASB status bitmask -> human-readable hard-fault reason, or
// null if clean. A hard fault means the ticket did NOT physically print even
// when the SDK reports res.success:true (a silent phantom "success").
//
// Bit VALUES are the epos-2.27.0 SDK's OWN ASB_* constants, verified against
// public/epos-2.27.0.js — the ePOS-Print API doc's abstract masks do NOT match
// these numeric values, so we use the SDK's. Fault-only: soft/transient states
// (ASB_RECEIPT_NEAR_END 0x20000, ASB_PAPER_FEED 0x40, ASB_DRAWER_KICK/
// ASB_BATTERY_OFFLINE 0x04) are intentionally NOT treated as failures.
function asbFaultReason(status) {
  if (status == null) return null
  const faults = []
  if (status & 0x00080000) faults.push('no paper')            // ASB_RECEIPT_END    524288
  if (status & 0x00000020) faults.push('cover open')          // ASB_COVER_OPEN         32
  if (status & 0x00000008) faults.push('printer offline')     // ASB_OFF_LINE            8
  if (status & 0x00000400) faults.push('mechanical error')    // ASB_MECHANICAL_ERR   1024
  if (status & 0x00000800) faults.push('autocutter error')    // ASB_AUTOCUTTER_ERR   2048
  if (status & 0x00002000) faults.push('unrecoverable error') // ASB_UNRECOVER_ERR    8192
  return faults.length ? faults.join(', ') : null
}

function fmt(amount) {
  return `$${Number(amount || 0).toFixed(2)}`
}

function pad(left, right) {
  const gap = W - left.length - right.length
  return left + (gap > 0 ? ' '.repeat(gap) : ' ') + right
}

// Same as pad() but for double-width 2x lines (24 effective chars).
function padDW(left, right) {
  const gap = DW - left.length - right.length
  return left + (gap > 0 ? ' '.repeat(gap) : ' ') + right
}

// Greedy word wrap. Lines fit within maxChars; a single word longer than
// maxChars is broken mid-word so nothing overflows the column.
function wrapText(text, maxChars) {
  if (!text) return ['']
  const words = text.split(' ')
  const lines = []
  let current = ''
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) { lines.push(current); current = '' }
      let rest = word
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars))
        rest = rest.slice(maxChars)
      }
      current = rest
    } else if ((current + (current ? ' ' : '') + word).length <= maxChars) {
      current = current ? `${current} ${word}` : word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

// Splits a single address string like "350 Ramapo Valley Rd, Oakland, NJ 07436"
// into ["350 Ramapo Valley Rd", "Oakland, NJ 07436"]. If the address can't be
// split confidently, returns the single line as-is.
function splitAddress(addr) {
  if (!addr) return []
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length <= 1) return parts
  // Pull off trailing "USA" / "United States" if present
  const last = parts[parts.length - 1].toLowerCase()
  if (last === 'usa' || last === 'united states') parts.pop()
  if (parts.length <= 1) return parts
  // Street is everything except the last 2 segments (city, state+zip), joined back
  const cityStateZip = parts.slice(-2).join(', ')
  const street = parts.slice(0, -2).join(', ')
  return street ? [street, cityStateZip] : [cityStateZip]
}

function fmtDate(dateStr) {
  const d = new Date(dateStr)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${date} · ${time}`
}

// "TODAY 7:15 PM" or "THU 5/7 7:15 PM" — UPPERCASE 3-letter day code.
// Used only by the FUTURE ORDER banner. Explicit America/New_York
// timezone so the receipt is right even if the tablet's locale drifts
// (defensive — current tablets are physically in NJ).
function fmtScheduledForReceipt(isoString) {
  const d = new Date(isoString)
  const tz = 'America/New_York'
  const dateOpts = { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }
  const todayKey = new Intl.DateTimeFormat('en-US', dateOpts).format(new Date())
  const scheduledKey = new Intl.DateTimeFormat('en-US', dateOpts).format(d)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d)
  if (todayKey === scheduledKey) return `TODAY ${time}`
  const dayShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  const monthDay = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'numeric', day: 'numeric',
  }).format(d)
  return `${dayShort.toUpperCase()} ${monthDay} ${time}`
}

/**
 * Print an order receipt on an Epson thermal printer (Slice-style format)
 * @param {string} printerIp - IP address of the printer
 * @param {object} order - Full order object with items
 * @param {object} rest - Restaurant info { name, address, phone }
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function printOrder(...args) {
  // Queue this job behind any in-flight print, then run it. `_printOrder` never
  // rejects (it always resolve()s a {success,...} object), but we .catch() the
  // chain link anyway so one job's failure can't break FIFO ordering for the
  // next. Callers await `run` and receive the real result unchanged.
  const run = printChain.then(() => _printOrder(...args))
  printChain = run.catch(() => {})
  return run
}

async function _printOrder(printerIp, order, rest, copies = 1) {
  if (!printerIp) return { success: false, message: 'No printer IP configured', code: null, status: null }
  if (!window.epson) return { success: false, message: 'Epson ePOS SDK not loaded', code: null, status: null }
  const copyCount = Math.min(5, Math.max(1, parseInt(copies) || 1))

  return new Promise((resolve) => {
    try {
      const ePosDev = new window.epson.ePOSDevice()
      const timeout = setTimeout(() => {
        console.error('[EpsonPrint] Connection timed out to', printerIp)
        resolve({ success: false, message: 'Printer connection timed out', code: null, status: null })
      }, 10000)

      ePosDev.connect(printerIp, 8008, (connectResult) => {
        if (connectResult !== 'OK' && connectResult !== 'SSL_CONNECT_OK') {
          clearTimeout(timeout)
          console.error('[EpsonPrint] Connection failed:', connectResult)
          resolve({ success: false, message: `Connection failed: ${connectResult}`, code: null, status: null })
          return
        }

        ePosDev.createDevice('local_printer', ePosDev.DEVICE_TYPE_PRINTER, { crypto: false, buffer: false }, (printer, retcode) => {
          clearTimeout(timeout)
          if (retcode !== 'OK' || !printer) {
            console.error('[EpsonPrint] Device creation failed:', retcode)
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: `Printer device error: ${retcode}`, code: null, status: null })
            return
          }

          // Send-phase timeout. The connect timeout above is already cleared, so
          // without this a hang after send() (onreceive/onerror never fires)
          // would wedge the Promise forever. Cleared at the top of onreceive and
          // onerror, and in the build/send catch below. A late callback after
          // this fires is harmless — the Promise ignores the second resolve()
          // and disconnect() is try/catch-wrapped.
          const sendTimeout = setTimeout(() => {
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: 'Printer send timed out', code: null, status: null })
          }, 15000)

          try {
            const sep = '-'.repeat(W)
            const eqLine = '='.repeat(W)
            const dotSep = '- '.repeat(W / 2)
            const items = order.items || []
            const C = printer.ALIGN_CENTER
            const L = printer.ALIGN_LEFT
            const bold = (on) => printer.addTextStyle(false, false, on, printer.COLOR_1)
            // Per-restaurant "large" receipt font: double the HEIGHT of the
            // ITEM-LOOP lines only (item name/price, size, modifiers, per-item
            // notes) while leaving WIDTH untouched, so character counts /
            // wrapping are unchanged. Used ONLY inside the item loop; every
            // other section prints via plain printer.addTextSize (always
            // standard height). Defaults to 'standard' when rest.receipt_font is
            // absent or null. In 'standard' mode setSize(w,h) resolves to
            // addTextSize(w,h), so the whole receipt is byte-identical to prior
            // behavior.
            const receiptFont = rest?.receipt_font === 'large' ? 'large' : 'standard'
            const setSize = (w, h) => printer.addTextSize(w, receiptFont === 'large' ? h * 2 : h)

            // Multi-copy: append [full receipt + feed + cut] once per copy into
            // the SAME buffer, then a single send() below. copyCount===1 (manual
            // reprints / retries) → one iteration → buffer byte-identical to the
            // pre-copies behavior. N>1 → N receipts back-to-back in one
            // connection, each with its own cut.
            for (let c = 0; c < copyCount; c++) {
            // ── 1. HEADER ──
            // Restaurant name 2x2 (double-double) for max legibility from
            // across the kitchen. Address split into street + city/state/zip
            // so it doesn't wrap unpredictably. Phone formatted via shared
            // helper so it always reads as (XXX) XXX-XXXX.
            printer.addTextAlign(C)
            bold(true)
            printer.addTextSize(2, 2)
            printer.addText((rest.name || '') + '\n')
            printer.addTextSize(1, 1)
            bold(false)
            const addrLines = splitAddress(rest.address)
            for (const line of addrLines) printer.addText(line + '\n')
            if (rest.phone) printer.addText(formatPhone(rest.phone) + '\n')

            // ── 1b. FUTURE ORDER BANNER ──
            // Visual flag for scheduled orders so the kitchen sees the
            // future-time call-out right under the restaurant header.
            // ASAP orders skip this section entirely.
            if (order.scheduled_for) {
              printer.addText(eqLine + '\n')
              bold(true)
              printer.addTextSize(2, 2)
              printer.addText('*** FUTURE ORDER ***\n')
              printer.addText(`*** ${fmtScheduledForReceipt(order.scheduled_for)} ***\n`)
              printer.addTextSize(1, 1)
              bold(false)
              printer.addText(eqLine + '\n')
            }

            printer.addText('\n')

            // ── 2. PICKUP/DELIVERY + PAID ──
            const typeLabel = order.order_type === 'delivery' ? 'DELIVERY' : 'PICKUP'
            bold(true)
            printer.addTextSize(2, 1)
            printer.addTextAlign(L)
            printer.addText(padDW(typeLabel, 'PAID') + '\n')
            printer.addTextSize(1, 1)
            bold(false)
            printer.addText('\n')

            // ── 3. ORDER INFO ──
            // Order # at 2x1 bold so the kitchen can scan it from across
            // the room when pulling tickets. Date stays 1x.
            bold(true)
            printer.addTextSize(2, 1)
            printer.addText(`Order #${order.order_number}\n`)
            printer.addTextSize(1, 1)
            bold(false)
            printer.addText(fmtDate(order.created_at) + '\n')
            printer.addText('\n')

            // ── 4. CUSTOMER ──
            // Promoted to its own block. Name at 2x1 bold because the
            // counter person calls it out when food is ready. Phone
            // formatted; delivery address only printed for delivery.
            bold(true)
            printer.addText('CUSTOMER\n')
            bold(false)
            printer.addTextSize(2, 1)
            bold(true)
            printer.addText((order.customer_name || '') + '\n')
            printer.addTextSize(1, 1)
            bold(false)
            if (order.customer_phone) printer.addText(formatPhone(order.customer_phone) + '\n')
            if (order.order_type === 'delivery' && order.delivery_address) {
              printer.addText(order.delivery_address + '\n')
            }
            printer.addText('\n')

            // ── 5. ITEMS ──
            // Item name + qty + price at 2x1 bold uppercase — the single
            // biggest legibility win. Three-tier width fallback handles
            // long item names without overflowing the 24-char 2x line.
            // Column header anchors the price column for the kitchen.
            printer.addText(pad('Qty  Item(s)', 'Price') + '\n')
            printer.addText(sep + '\n')

            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx]
              const topsTotal = (item.order_item_toppings || item.toppings || []).reduce(
                (s, t) => s + Number(t.price_charged || t.price || 0), 0
              )
              const lineTotal = (Number(item.base_price || item.basePrice || 0) + topsTotal) * (item.quantity || 1)
              const qty = item.quantity || 1
              const rawName = (item.item_name || item.itemName || '').toUpperCase()
              const sizeName = item.size_name || item.sizeName || ''
              const qtyPrefix = `${qty}x  ` // 4+ chars; longer if qty has 2 digits
              const priceStr = fmt(lineTotal)

              // Wrap the name across as many 2x bold lines as needed.
              // Line 1 reserves the right side for the price; continuation
              // lines indent to align under the item name (4 spaces at 2x =
              // same horizontal offset as "1x  " on line 1). If the first
              // wrapped line is too long to share its line with the price,
              // re-wrap that line tighter and push the overflow onto the
              // continuation list.
              const line1Capacity = DW - qtyPrefix.length - 1 - priceStr.length
              const continuationCapacity = DW - qtyPrefix.length
              const wrappedLines = wrapText(rawName, continuationCapacity)
              const indent = ' '.repeat(qtyPrefix.length)

              bold(true)
              setSize(2, 1)

              // Print the line 1 in two parts so the qty+name stays bold
              // and the price drops to non-bold (still 2x), making the
              // price visually recede next to the bigger item name.
              let continuationStart
              if (wrappedLines[0].length <= line1Capacity) {
                const namePart = qtyPrefix + wrappedLines[0]
                const padding = ' '.repeat(Math.max(1, DW - namePart.length - priceStr.length))
                printer.addText(namePart + padding)
                bold(false)
                printer.addText(priceStr + '\n')
                bold(true)
                continuationStart = 1
              } else {
                const firstLineWrapped = wrapText(wrappedLines[0], line1Capacity)
                const namePart = qtyPrefix + firstLineWrapped[0]
                const padding = ' '.repeat(Math.max(1, DW - namePart.length - priceStr.length))
                printer.addText(namePart + padding)
                bold(false)
                printer.addText(priceStr + '\n')
                bold(true)
                // Replace wrappedLines[0] with the overflow from the
                // re-wrap; only firstLineWrapped[0] has been printed, so
                // the loop must start at index 0 to render the rest.
                wrappedLines.splice(0, 1, ...firstLineWrapped.slice(1))
                continuationStart = 0
              }

              for (let i = continuationStart; i < wrappedLines.length; i++) {
                printer.addText(indent + wrappedLines[i] + '\n')
              }

              setSize(1, 1)
              bold(false)

              // Sub-item lines (size, modifiers, per-item Note) print at
              // 1x1 bold all-caps. Bold + caps gives kitchen legibility
              // without the receipt-length cost of 1x2 height stretch.
              if (sizeName) {
                bold(true)
                printer.addText(`        ${sizeName.toUpperCase()}\n`)
                bold(false)
              }

              // Modifiers — bare `+` prefix (no space after) so the plus
              // sits directly under the item-name column. 8-space indent
              // aligns the `+` with the start of the 2x item name (4 chars
              // at 2x = 8 chars of 1x width). LEFT/RIGHT/WHOLE placement
              // preserved; addons skip the placement label.
              const toppings = item.order_item_toppings || item.toppings || []
              for (const t of toppings) {
                const tName = t.topping_name || t.toppingName
                const tPrice = Number(t.price_charged || t.price || 0)
                const isAddon = (t.placement_type || t.placementType) === 'addon'
                const placement = isAddon ? '' : `${(t.placement || '').toUpperCase()}: `
                const tPriceStr = tPrice === 0 ? 'Free' : `+${fmt(tPrice)}${qty > 1 ? ' ea' : ''}`
                bold(true)
                printer.addText(`        +${placement}${tName.toUpperCase()}  ${tPriceStr}\n`)
                bold(false)
              }

              // Per-item special instructions — sits with the item it
              // belongs to (distinct from the order-level NOTE block in
              // Section 6). Same 8-space indent as size and modifiers.
              const instructions = item.special_instructions || item.specialInstructions
              if (instructions) {
                bold(true)
                printer.addText(`        NOTE: ${instructions.toUpperCase()}\n`)
                bold(false)
              }

              if (Number(order.discount_percentage) > 0 && item.discount_exempt === true) {
                printer.addText('        *already discounted*\n')
              }

              // Dotted divider between items.
              if (idx < items.length - 1) {
                printer.addText(dotSep + '\n')
              }
            }

            // In 'large' mode the item loop leaves the printer at doubled
            // height; reset so everything below (utensils, order NOTE, totals,
            // footer) prints at standard height. Guarded on 'large' so the
            // command stream stays byte-identical in standard mode.
            if (receiptFont === 'large') printer.addTextSize(1, 1)

            if (order.include_utensils) {
              printer.addText('\n')
              printer.addTextAlign(C)
              bold(true)
              printer.addText('*** NAPKINS & UTENSILS REQUESTED ***\n')
              bold(false)
              printer.addTextAlign(L)
            }

            // ── 6. SPECIAL INSTRUCTIONS (order-level) ──
            // Promoted to a centered callout between items and totals so
            // the kitchen can't miss it.
            if (order.special_instructions) {
              printer.addText('\n')
              printer.addTextAlign(C)
              printer.addText(eqLine + '\n')
              bold(true)
              printer.addText('*** NOTE ***\n')
              bold(false)
              printer.addText(order.special_instructions + '\n')
              printer.addText(eqLine + '\n')
              printer.addTextAlign(L)
            }

            printer.addText('\n')

            // ── 7. TOTALS ──
            printer.addText(sep + '\n')
            printer.addText(pad('Subtotal', fmt(order.subtotal)) + '\n')
            if (Number(order.discount_amount) > 0) {
              printer.addText(pad(`Discount (${order.discount_percentage}% off)`, `-${fmt(order.discount_amount)}`) + '\n')
            }
            if (Number(order.delivery_fee) > 0) {
              printer.addText(pad('Delivery', fmt(order.delivery_fee)) + '\n')
            }
            printer.addText(pad('Tax', fmt(order.tax_amount)) + '\n')
            if (Number(order.tip_amount) > 0) {
              printer.addText(pad('Tip', fmt(order.tip_amount)) + '\n')
            }
            printer.addText(pad('Service Fee', fmt(order.service_fee)) + '\n')
            printer.addText(sep + '\n')
            printer.addText('\n') // breathing room above TOTAL

            // TOTAL — 2x1 bold
            bold(true)
            printer.addTextSize(2, 1)
            printer.addText(padDW('TOTAL', fmt(order.total_amount)) + '\n')
            printer.addTextSize(1, 1)
            bold(false)
            printer.addText(sep + '\n')

            // ── 7. FOOTER ──
            printer.addText('\n')
            printer.addTextAlign(C)
            printer.addText('Thank you for ordering direct!\n')
            bold(true)
            printer.addText('powered by DirectBite\n')
            bold(false)
            printer.addText('\n')

            if (order.include_utensils) {
              bold(true)
              printer.addText('*** NAPKINS & UTENSILS REQUESTED ***\n')
              bold(false)
            }

            printer.addFeedLine(4)
            printer.addCut(printer.CUT_FEED)
            }

            // Send
            printer.onreceive = (res) => {
              clearTimeout(sendTimeout)
              try { ePosDev.deleteDevice(printer) } catch {}
              try { ePosDev.disconnect() } catch {}
              // A hard ASB fault overrides res.success — the SDK can report
              // success:true while a fault bit (paper out, cover open, offline)
              // means nothing physically printed.
              const fault = asbFaultReason(res.status)
              if (res.success && !fault) {
                resolve({ success: true, message: 'Printed successfully', code: res.code, status: res.status })
              } else {
                const reason = fault ? `Printer fault: ${fault}` : `Print error: code ${res.code}`
                resolve({ success: false, message: reason, code: res.code, status: res.status })
              }
            }

            printer.onerror = (err) => {
              clearTimeout(sendTimeout)
              console.error('[EpsonPrint] Printer error:', err)
              try { ePosDev.disconnect() } catch {}
              resolve({ success: false, message: `Print error: ${err}`, code: null, status: null })
            }

            printer.send()
          } catch (err) {
            clearTimeout(sendTimeout)
            console.error('[EpsonPrint] Send error:', err)
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: `Print error: ${err.message}`, code: null, status: null })
          }
        })
      })
    } catch (err) {
      console.error('[EpsonPrint] Fatal error:', err)
      resolve({ success: false, message: `Print error: ${err.message}`, code: null, status: null })
    }
  })
}
