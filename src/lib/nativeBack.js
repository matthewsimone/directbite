import { useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import toast from 'react-hot-toast'
import { IS_NATIVE } from './native'

// Android hardware/gesture back. Open overlays register here; back closes the
// topmost one, else navigates history, else minimizes (never exits).
// Web: the hook is a no-op and the listener is never installed.
//
// Overlay entries (sheets, modals — the default) also drive toasts: opening one
// removes any visible toast, and while any is open html.ordr-sheet-open is set
// so NativeToaster defaults new toasts to the top. Non-overlay entries
// (SettingsPage sub-view back) pass { overlay: false } and do neither.
const stack = []
let nextId = 0

function syncSheetOpen() {
  document.documentElement.classList.toggle('ordr-sheet-open', stack.some((e) => e.overlay))
}

export function useNativeBack(active, close, { overlay = true } = {}) {
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!IS_NATIVE || !active) return
    const entry = { id: ++nextId, overlay, close: () => closeRef.current() }
    stack.push(entry)
    // Only at the moment of opening; toasts fired afterwards still show.
    if (overlay) toast.remove()
    syncSheetOpen()
    return () => {
      const i = stack.findIndex((e) => e.id === entry.id)
      if (i !== -1) stack.splice(i, 1)
      syncSheetOpen()
    }
  }, [active, overlay])
}

export async function installNativeBackHandler() {
  if (!IS_NATIVE || Capacitor.getPlatform() !== 'android') return
  try {
    const { App } = await import('@capacitor/app')
    App.addListener('backButton', ({ canGoBack }) => {
      const top = stack.pop()
      syncSheetOpen()
      if (top) {
        top.close()
      } else if (canGoBack) {
        window.history.back()
      } else {
        App.minimizeApp()
      }
    })
  } catch (err) {
    console.warn('[nativeBack] backButton listener not installed', err)
  }
}
