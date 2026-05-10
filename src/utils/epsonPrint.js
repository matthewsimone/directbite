// Epson ePOS SDK direct printing for DirectBite
// Requires epos-2.27.0.js loaded via <script> tag
// TM-M30 80mm paper = 48 characters wide

const W = 48

function fmt(amount) {
  return `$${Number(amount || 0).toFixed(2)}`
}

function pad(left, right) {
  const gap = W - left.length - right.length
  return left + (gap > 0 ? ' '.repeat(gap) : ' ') + right
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
            const dotSep = '- '.repeat(W / 2)
            const DW = W / 2 // double-width chars per line
            const items = order.items || []
            const C = printer.ALIGN_CENTER
            const L = printer.ALIGN_LEFT
            const bold = (on) => printer.addTextStyle(false, false, on, printer.COLOR_1)

            // ── 1. HEADER ──
            printer.addTextAlign(C)
            bold(true)
            printer.addTextSize(2, 1)
            printer.addText((rest.name || '') + '\n')
            printer.addTextSize(1, 1)
            bold(false)
            if (rest.address) printer.addText(rest.address + '\n')
            if (rest.phone) printer.addText(rest.phone + '\n')

            // ── 1b. FUTURE ORDER BANNER ──
            // Visual flag for scheduled orders so the kitchen sees the
            // future-time call-out right under the restaurant header.
            // ASAP orders skip this section entirely.
            if (order.scheduled_for) {
              const eqLine = '='.repeat(W)
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
            const typeGap = DW - typeLabel.length - 4 // 4 = "PAID".length
            printer.addText(typeLabel + (typeGap > 0 ? ' '.repeat(typeGap) : ' ') + 'PAID\n')
            printer.addTextSize(1, 1)
            bold(false)
            printer.addText('\n')

            // ── 3. ORDER INFO ──
            printer.addText(`Order · #DirectBite ${order.order_number}\n`)
            printer.addText(fmtDate(order.created_at) + '\n')
            printer.addText('\n')
            printer.addText(order.customer_name + '\n')
            printer.addText(order.customer_phone + '\n')
            if (order.order_type === 'delivery' && order.delivery_address) {
              printer.addText(order.delivery_address + '\n')
            }
            printer.addText('\n')

            // ── SPECIAL INSTRUCTIONS ──
            if (order.special_instructions) {
              printer.addTextAlign(L)
              printer.addText(sep + '\n')
              bold(true)
              printer.addText('INSTRUCTIONS:\n')
              bold(false)
              printer.addText(order.special_instructions + '\n')
              printer.addText(sep + '\n')
              printer.addText('\n')
            }

            // ── 4. COLUMN HEADERS ──
            printer.addTextAlign(L)
            printer.addText(pad('Qty  Item(s)', 'Price') + '\n')
            printer.addText(sep + '\n')

            // ── 5. ITEMS ──
            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx]
              const topsTotal = (item.order_item_toppings || item.toppings || []).reduce(
                (s, t) => s + Number(t.price_charged || t.price || 0), 0
              )
              const lineTotal = (Number(item.base_price || item.basePrice || 0) + topsTotal) * (item.quantity || 1)
              const qty = item.quantity || 1
              const name = item.item_name || item.itemName || ''
              const sizeName = item.size_name || item.sizeName || ''

              // Item line — bold name + right-aligned price
              bold(true)
              printer.addText(pad(`${qty}x   ${name}`, fmt(lineTotal)) + '\n')
              bold(false)

              // Size on separate line if exists
              if (sizeName) {
                printer.addText(`     ${sizeName}\n`)
              }

              // Toppings
              const toppings = item.order_item_toppings || item.toppings || []
              for (const t of toppings) {
                const tName = t.topping_name || t.toppingName
                const tPrice = Number(t.price_charged || t.price || 0)
                const isAddon = (t.placement_type || t.placementType) === 'addon'
                const placement = isAddon ? '' : `${(t.placement || '').toUpperCase()}: `
                const priceStr = tPrice === 0 ? 'Free' : `+${fmt(tPrice)}${qty > 1 ? ' ea' : ''}`
                printer.addText(`     +${placement}${tName} ${priceStr}\n`)
              }

              // Special instructions
              const instructions = item.special_instructions || item.specialInstructions
              if (instructions) {
                printer.addText(`     Note: ${instructions}\n`)
              }

              // Item divider (except after last item)
              if (idx < items.length - 1) {
                printer.addText(dotSep + '\n')
              }
            }

            // Utensils notice (in items section)
            if (order.include_utensils) {
              printer.addText('\n')
              printer.addTextAlign(C)
              bold(true)
              printer.addText('*** NAPKINS & UTENSILS REQUESTED ***\n')
              bold(false)
              printer.addTextAlign(L)
            }

            // ── 6. TOTALS ──
            printer.addText(sep + '\n')
            printer.addText(pad('Subtotal', fmt(order.subtotal)) + '\n')
            printer.addText(pad('Tax', fmt(order.tax_amount)) + '\n')
            printer.addText(pad('Service Fee', fmt(order.service_fee)) + '\n')
            if (Number(order.delivery_fee) > 0) {
              printer.addText(pad('Delivery', fmt(order.delivery_fee)) + '\n')
            }
            if (Number(order.discount_amount) > 0) {
              printer.addText(pad(`Discount (${order.discount_percentage}% off)`, `-${fmt(order.discount_amount)}`) + '\n')
            }
            if (Number(order.tip_amount) > 0) {
              printer.addText(pad('Tip', fmt(order.tip_amount)) + '\n')
            }
            printer.addText(sep + '\n')

            // TOTAL — bold, double width, on one line
            bold(true)
            printer.addTextSize(2, 1)
            printer.addTextAlign(L)
            const totalAmt = fmt(order.total_amount)
            const totalGap = DW - 5 - totalAmt.length // 5 = "TOTAL".length
            printer.addText('TOTAL' + (totalGap > 0 ? ' '.repeat(totalGap) : ' ') + totalAmt + '\n')
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
