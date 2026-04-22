// Epson ePOS SDK direct printing for DirectBite
// Requires epos-2.27.0.js loaded via <script> tag

function formatMoney(amount) {
  return `$${Number(amount || 0).toFixed(2)}`
}

function formatDate(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function padLine(left, right, width = 32) {
  const gap = width - left.length - right.length
  return left + (gap > 0 ? '.'.repeat(gap) : ' ') + right
}

/**
 * Print an order receipt on an Epson thermal printer
 * @param {string} printerIp - IP address of the printer
 * @param {object} order - Full order object from Supabase
 * @param {string} restaurantName - Restaurant name for header
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function printOrder(printerIp, order, restaurantName) {
  if (!printerIp) {
    return { success: false, message: 'No printer IP configured' }
  }

  if (!window.epson) {
    return { success: false, message: 'Epson ePOS SDK not loaded' }
  }

  return new Promise((resolve) => {
    const ePosDev = new window.epson.ePOSDevice()

    // Connection timeout
    const timeout = setTimeout(() => {
      resolve({ success: false, message: 'Printer connection timed out' })
    }, 10000)

    ePosDev.connect(printerIp, 8008, (connectResult) => {
      if (connectResult !== 'OK' && connectResult !== 'SSL_CONNECT_OK') {
        clearTimeout(timeout)
        resolve({ success: false, message: `Connection failed: ${connectResult}` })
        return
      }

      ePosDev.createDevice('local_printer', ePosDev.DEVICE_TYPE_PRINTER, { crypto: false, buffer: false }, (printer, retcode) => {
        clearTimeout(timeout)

        if (retcode !== 'OK' || !printer) {
          try { ePosDev.disconnect() } catch {}
          resolve({ success: false, message: `Printer device error: ${retcode}` })
          return
        }

        try {
          const sep = '--------------------------------'
          const items = order.items || []

          // Header
          printer.addTextAlign(printer.ALIGN_CENTER)
          printer.addTextStyle(false, false, true, printer.COLOR_1)
          printer.addTextSize(2, 2)
          printer.addText(restaurantName + '\n')
          printer.addTextSize(1, 1)
          printer.addTextStyle(false, false, false, printer.COLOR_1)
          printer.addText(sep + '\n')

          // Order info
          printer.addTextAlign(printer.ALIGN_LEFT)
          printer.addText(`DirectBite Order #${order.order_number}\n`)
          printer.addTextAlign(printer.ALIGN_CENTER)
          printer.addTextStyle(false, false, true, printer.COLOR_1)
          printer.addText('PAID\n')
          printer.addText(order.order_type.toUpperCase() + '\n')
          printer.addTextStyle(false, false, false, printer.COLOR_1)
          printer.addTextAlign(printer.ALIGN_LEFT)
          printer.addText(formatDate(order.created_at) + '\n')
          printer.addText(order.customer_name + '\n')
          printer.addText(order.customer_phone + '\n')
          if (order.order_type === 'delivery' && order.delivery_address) {
            printer.addText(order.delivery_address + '\n')
          }
          printer.addText(sep + '\n')

          // Items
          for (const item of items) {
            const topsTotal = (item.order_item_toppings || item.toppings || []).reduce(
              (s, t) => s + Number(t.price_charged || t.price || 0), 0
            )
            const lineTotal = (Number(item.base_price || item.basePrice || 0) + topsTotal) * (item.quantity || 1)
            const itemName = `${item.quantity}x ${item.item_name || item.itemName}${item.size_name || item.sizeName ? ` (${item.size_name || item.sizeName})` : ''}`
            printer.addText(padLine(itemName, formatMoney(lineTotal)) + '\n')

            const toppings = item.order_item_toppings || item.toppings || []
            for (const t of toppings) {
              const tName = t.topping_name || t.toppingName
              const tPrice = Number(t.price_charged || t.price || 0)
              const tPlacement = (t.placement_type || t.placementType) === 'addon' ? '' : `${(t.placement || '').toUpperCase()}: `
              const qty = item.quantity || 1
              const priceStr = tPrice === 0 ? 'Free' : `+${formatMoney(tPrice)}${qty > 1 ? ' ea' : ''}`
              printer.addText(`  ${tPlacement}${tName}  ${priceStr}\n`)
            }
          }

          // Utensils
          if (order.include_utensils) {
            printer.addText('\n')
            printer.addTextAlign(printer.ALIGN_CENTER)
            printer.addTextStyle(false, false, true, printer.COLOR_1)
            printer.addText('*** NAPKINS & UTENSILS REQUESTED ***\n')
            printer.addTextStyle(false, false, false, printer.COLOR_1)
            printer.addTextAlign(printer.ALIGN_LEFT)
          }

          // Totals
          printer.addText(sep + '\n')
          printer.addTextAlign(printer.ALIGN_RIGHT)
          printer.addText(padLine('Subtotal', formatMoney(order.subtotal)) + '\n')
          printer.addText(padLine('Tax', formatMoney(order.tax_amount)) + '\n')
          printer.addText(padLine('Service Fee', formatMoney(order.service_fee)) + '\n')
          if (Number(order.delivery_fee) > 0) {
            printer.addText(padLine('Delivery', formatMoney(order.delivery_fee)) + '\n')
          }
          if (Number(order.discount_amount) > 0) {
            printer.addText(padLine('Discount', `-${formatMoney(order.discount_amount)} (${order.discount_percentage}% off)`) + '\n')
          }
          if (Number(order.tip_amount) > 0) {
            printer.addText(padLine('Tip', formatMoney(order.tip_amount)) + '\n')
          }
          printer.addText(sep + '\n')
          printer.addTextStyle(false, false, true, printer.COLOR_1)
          printer.addText(padLine('TOTAL', formatMoney(order.total_amount)) + '\n')
          printer.addTextStyle(false, false, false, printer.COLOR_1)
          printer.addText(sep + '\n')

          // Footer
          printer.addTextAlign(printer.ALIGN_CENTER)
          printer.addText('Thank you for ordering direct!\n')
          printer.addTextStyle(false, false, true, printer.COLOR_1)
          printer.addText('powered by DirectBite\n')
          printer.addTextStyle(false, false, false, printer.COLOR_1)

          // Feed and cut
          printer.addFeedLine(3)
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
            try { ePosDev.disconnect() } catch {}
            resolve({ success: false, message: `Print error: ${err}` })
          }

          printer.send()
        } catch (err) {
          try { ePosDev.disconnect() } catch {}
          resolve({ success: false, message: `Print error: ${err.message}` })
        }
      })
    })
  })
}
