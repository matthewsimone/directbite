import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { IS_NATIVE } from './lib/native'
import { hydrateToken } from './lib/tokenStore'
import { installExternalLinkHandler } from './lib/externalLinks'

const rootEl = document.getElementById('root')
const app = (
  <StrictMode>
    <App />
  </StrictMode>
)

// Native shell marker. index.css scopes every safe-area rule to html.native,
// so none of it can match on web.
if (IS_NATIVE) document.documentElement.classList.add('native')
installExternalLinkHandler()

// Prerendered routes (SSG, e.g. /test/home) ship HTML inside #root → hydrate
// it. Every other route ships an empty #root → createRoot exactly as before
// (byte-identical to the prior behavior).
function mount() {
  if (rootEl.hasChildNodes()) {
    hydrateRoot(rootEl, app)
  } else {
    createRoot(rootEl).render(app)
  }
}

// Native: load the stored session token before first render so reads stay
// synchronous. Capped at 1.5s — a stuck plugin mounts logged-out, never blank.
// Web mounts immediately, exactly as before.
if (IS_NATIVE) {
  Promise.race([hydrateToken(), new Promise((r) => setTimeout(r, 1500))]).finally(mount)
} else {
  mount()
}
