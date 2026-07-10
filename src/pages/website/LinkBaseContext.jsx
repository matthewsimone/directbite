import { createContext, useContext } from 'react'

// Link-base context for restaurant website pages (home / menu / places).
//
// These SEO pages render at TWO different URL bases:
//   - main domain:   /{slug}/menu, /{slug}/places/{town}   → base = `/{slug}`
//   - custom domain: /menu, /places/{town}                 → base = `` (bare)
//
// The base must be an EXPLICIT input, not derived from isMainDomain(): during
// prerender there is no window, so isMainDomain() returns true and would bake
// the main-domain (slug-prefixed) base into custom-domain restaurants' pages.
//
// The provider is mounted at the three render contexts (prerender,
// CustomDomainShell, the MainRoutes SEO routes). useLinkBase() returns null
// when NO provider is present, so shared consumers (OrderLink, TopBar) can fall
// back to today's isMainDomain() behavior on unwrapped pages (MenuPage,
// Checkout, Tablet) and stay byte-identical.
//
// SAFETY: unlike useCart, this deliberately does NOT throw on a missing
// provider — a throw would crash every unwrapped page that renders OrderLink.
// A provided value of `` (empty string, the custom-domain base) is distinct
// from null (no provider); consumers must test `!== null`, not falsiness.

const LinkBaseContext = createContext(null)

export function LinkBaseProvider({ value, children }) {
  return <LinkBaseContext.Provider value={value}>{children}</LinkBaseContext.Provider>
}

export function useLinkBase() {
  return useContext(LinkBaseContext)
}
