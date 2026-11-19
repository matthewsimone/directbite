/**
 * CORS for pos-v1-price-order, limited to what the web checkout needs.
 *
 * Checkout runs on the app origin and on each restaurant's custom domain
 * (restaurants.custom_domain, apex or www). Allowed:
 *   - exact origins in POS_V1_ALLOWED_ORIGINS (comma-separated, e.g. the
 *     app's https origin and http://localhost:5173 for dev);
 *   - https://<custom_domain> and https://www.<custom_domain>.
 * Only POST + OPTIONS, only the headers the checkout sends. No credentials.
 *
 * A request with no Origin header (server-to-server, the POS later) gets no
 * CORS headers and is not blocked. A browser request from any other origin is
 * refused with 403 origin_not_allowed.
 */

export const ALLOWED_METHODS = 'POST, OPTIONS';
export const ALLOWED_HEADERS = 'authorization, apikey, content-type, x-client-info, x-ordr-api-version';

export function parseOriginList(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));
}

export function isOriginAllowed(origin: string, staticOrigins: Set<string>, customDomains: Set<string>): boolean {
  const o = origin.trim().toLowerCase();
  if (staticOrigins.has(o)) return true;
  let url: URL;
  try {
    url = new URL(o);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/') return false;
  const host = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
  return customDomains.has(host);
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
