/**
 * Server geocoding for POS delivery quotes (DELIVERY.md §2: the server geocodes; the device never sends coordinates).
 * COPIED from supabase/functions/admin-create-restaurant/index.ts :80-98 (the GOOGLE_MAPS_API_KEY geocode), pinned by
 * hash: sha256 7471a7b6bfa37c4308927106072e607db454299a7c5d15252b3a237d76c7bba9 (_shared/pos-online/webPins.json).
 * The copy differs ONLY in: (1) the key and fetch are injected; (2) it also returns the formatted address and
 * Google's partial_match (→ the quote's needs_confirmation); (3) "no result" (ZERO_RESULTS) and "could not ask"
 * (no key / network / other status) are told apart — a bad address is a 400, an unreachable geocoder a 503 (the POS
 * then offers the offline rate); (4) console.* → the injected log.
 */
export type GeocodeResult =
  | { kind: 'ok'; lat: number; lng: number; formatted: string; partial: boolean }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; detail: string };

export async function geocodeAddress(
  o: { key: string | undefined; fetch: typeof fetch; log: (event: string, data?: Record<string, unknown>) => void },
  addr: string,
): Promise<GeocodeResult> {
  const gmapsKey = o.key;
  if (!gmapsKey || !addr) return { kind: 'unavailable', detail: gmapsKey ? 'no address' : 'GOOGLE_MAPS_API_KEY not set' };
  try {
    const geoRes = await o.fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${gmapsKey}`
    );
    const geoData = await geoRes.json();
    if (geoData.status === "OK" && geoData.results?.length > 0) {
      const r0 = geoData.results[0];
      const loc = r0.geometry.location;
      return { kind: 'ok', lat: loc.lat, lng: loc.lng, formatted: typeof r0.formatted_address === 'string' ? r0.formatted_address : addr, partial: r0.partial_match === true };
    }
    if (geoData.status === "ZERO_RESULTS") return { kind: 'not_found' };
    o.log('geocode_no_result', { status: geoData.status });
    return { kind: 'unavailable', detail: String(geoData.status) };
  } catch (geoErr) {
    o.log('geocode_failed', { error: geoErr instanceof Error ? geoErr.message : String(geoErr) });
    return { kind: 'unavailable', detail: 'network' };
  }
}
