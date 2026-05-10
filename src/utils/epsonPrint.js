// Epson ePOS SDK direct printing for DirectBite
// Requires epos-2.27.0.js loaded via <script> tag
// TM-M30 80mm paper = 48 characters wide

import { formatPhone } from './format'

const W = 48
const DW = W / 2 // double-width chars per line at 2x size = 24

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
export async function printOrder(printerIp, order, rest) {
  if (!printerIp) return { success: false, message: 'No printer IP configured' }
  if (!window.epson) return { success: false, message: 'Epson ePOS SDK not loaded' }

  return new Promise((resolve) => {
    try {
      const ePosDev = new window.epson.ePOSDevice()
      const timeout = setTimeout(() => {
        console.error('[EpsonPrint] Connection timed out to', printerIp)
        resolve({ success: false, message: 'Printer connection timed out' })
      }, 10000)

      ePosDev.connect(printerIp, 8008, (connectResult) => {
        if (connectResult !== 'OK' && connectResult !== 'SSL_CONNECT_OK') {
          clearTimeout(timeout)
          console.error('[EpsonPrint] Connection failed:', connectResult)
          resolve({ success: false, message: `Connection failed: ${connectResult}` })
          return
        }

        ePosDev.createDevice('local_printer', ePosDev.DEVICE_TYPE_PRINTER, { crypto: false, buffer: false }, (printer, retcode) => {
          clearTimeout(timeout)
          if (retcode !== 'OK' || !printer) {
            console.error('[EpsonPrint] Device creation failed:', retcode)
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: `Printer device error: ${retcode}` })
            return
          }

          try {
            const sep = '-'.repeat(W)
            const eqLine = '='.repeat(W)
            const items = order.items || []
            const C = printer.ALIGN_CENTER
            const L = printer.ALIGN_LEFT
            const bold = (on) => printer.addTextStyle(false, false, on, printer.COLOR_1)

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

              // Tier 1: qty + NAME + price all fit on one 2x line (≤24 chars)
              if (qtyPrefix.length + rawName.length + 1 + priceStr.length <= DW) {
                bold(true)
                printer.addTextSize(2, 1)
                printer.addText(padDW(qtyPrefix + rawName, priceStr) + '\n')
                printer.addTextSize(1, 1)
                bold(false)
              } else if (qtyPrefix.length + rawName.length <= DW) {
                // Tier 2: name fits at 2x but no room for price → 2x line
                // for qty+name, then 1x line with right-aligned price.
                bold(true)
                printer.addTextSize(2, 1)
                printer.addText(qtyPrefix + rawName + '\n')
                printer.addTextSize(1, 1)
                bold(false)
                printer.addText(pad('', priceStr) + '\n')
              } else {
                // Tier 3: name too long even at 2x → fall back to 1x bold
                // full line, same shape as the original receipt.
                bold(true)
                printer.addText(pad(qtyPrefix + rawName, priceStr) + '\n')
                bold(false)
              }

              if (sizeName) {
                printer.addText(`    ${sizeName}\n`)
              }

              // Modifiers — `> ` ASCII prefix (chosen over `→` for codepage
              // safety). LEFT/RIGHT/WHOLE placement is preserved; addons
              // skip the placement label.
              const toppings = item.order_item_toppings || item.toppings || []
              for (const t of toppings) {
                const tName = t.topping_name || t.toppingName
                const tPrice = Number(t.price_charged || t.price || 0)
                const isAddon = (t.placement_type || t.placementType) === 'addon'
                const placement = isAddon ? '' : `${(t.placement || '').toUpperCase()}: `
                const tPriceStr = tPrice === 0 ? 'Free' : `+${fmt(tPrice)}${qty > 1 ? ' ea' : ''}`
                printer.addText(`    > ${placement}${tName}  ${tPriceStr}\n`)
              }

              // Per-item special instructions — italic-style "Note:" prefix
              // sits with the item it belongs to (distinct from the
              // order-level NOTE block in Section 6).
              const instructions = item.special_instructions || item.specialInstructions
              if (instructions) {
                printer.addText(`    Note: ${instructions}\n`)
              }

              // Single blank line between items (no dotted divider).
              if (idx < items.length - 1) {
                printer.addText('\n')
              }
            }

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

            // Send
            printer.onreceive = (res) => {
              try { ePosDev.deleteDevice(printer) } catch {}
              try { ePosDev.disconnect() } catch {}
              if (res.success) {
                resolve({ success: true, message: 'Printed successfully' })
              } else {
                resolve({ success: false, message: `Print error: code ${res.code}` })
              }
            }

            printer.onerror = (err) => {
              console.error('[EpsonPrint] Printer error:', err)
              try { ePosDev.disconnect() } catch {}
              resolve({ success: false, message: `Print error: ${err}` })
            }

            printer.send()
          } catch (err) {
            console.error('[EpsonPrint] Send error:', err)
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: `Print error: ${err.message}` })
          }
        })
      })
    } catch (err) {
      console.error('[EpsonPrint] Fatal error:', err)
      resolve({ success: false, message: `Print error: ${err.message}` })
    }
  })
}
