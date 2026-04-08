import { useState, useEffect } from 'react'

export default function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [isInstalled, setIsInstalled] = useState(false)

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setIsInstalled(true)
      return
    }

    function handleBeforeInstallPrompt(e) {
      e.preventDefault()
      setDeferredPrompt(e)
    }

    function handleAppInstalled() {
      setIsInstalled(true)
      setDeferredPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  async function handleInstall() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setDeferredPrompt(null)
    }
  }

  if (isInstalled || dismissed || !deferredPrompt) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      {/* Backdrop */}
      <div className="absolute inset-0 -top-screen" onClick={() => setDismissed(true)} />

      {/* Banner */}
      <div className="relative bg-white border-t border-gray-200 shadow-lg px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-700">
          Install <strong>DirectBite</strong> for the best experience
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setDismissed(true)}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            Dismiss
          </button>
          <button
            onClick={handleInstall}
            className="px-4 py-1.5 bg-[#16A34A] text-white text-sm font-semibold rounded-lg hover:bg-[#15803D] transition-colors"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  )
}
