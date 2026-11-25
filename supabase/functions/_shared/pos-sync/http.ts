/**
 * HTTP envelope for pos-v1 DEVICE functions (ordr-pos docs/SYNC-CONTRACT.md §1, §3.3, §5, §6).
 *
 *  - Errors: `{ "error": { "code", "message", "field"? , ...extra } }` (SYNC §3.3). NOT the flat
 *    `{ code, message }` of the web's pos-v1-price-order (_shared/pos-v1/errors.ts).
 *  - Version gate: `x-ordr-api-version` must be exactly `1`, else 426 `upgrade_required` with
 *    `min_api_version` (SYNC §6). price-order answers 400 for this; device functions must not.
 *  - 429 carries a `Retry-After` header in whole seconds.
 *  - CORS: devices are native (no CORS), but browser tools may call these, so the device headers
 *    are allow-listed.
 *  - Caller IP: cf-connecting-ip → x-real-ip → x-forwarded-for first hop (last resort; spoofable)
 *    → none (shared 0.0.0.0 bucket). VERIFY ON DEPLOY which header the Supabase gateway sets.
 *
 * Handlers are pure (`DeviceRequest` → `DeviceResult`) so tests run without a server.
 */

export const API_VERSION = 1;
export const API_VERSION_HEADER = 'x-ordr-api-version';
/** Request bodies above this are refused (400 invalid_payload). */
export const MAX_DEVICE_BODY_BYTES = 256 * 1024;

export const DEVICE_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-client-info, x-ordr-api-version, x-ordr-client, x-ordr-device-id, x-ordr-device-token',
  'Access-Control-Expose-Headers': 'Retry-After',
};

export interface DeviceRequest {
  method: string;
  headers: Headers;
  bodyText: string;
  /** Caller IP (see callerIpWithSource); null when unknown. */
  ip: string | null;
  /** Which header `ip` came from — log this, never the IP. */
  ipSource?: IpSource;
}

export interface DeviceResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ErrorExtra {
  field?: string;
  /** Adds a `Retry-After` header (seconds, rounded up, ≥ 1). */
  retryAfterMs?: number;
  /** Extra keys inside `error` (e.g. min_api_version, server_version). */
  [k: string]: unknown;
}

export function errorResult(status: number, code: string, message: string, extra: ErrorExtra = {}): DeviceResult {
  const { retryAfterMs, ...rest } = extra;
  const result: DeviceResult = { status, body: { error: { code, message, ...rest } } };
  if (typeof retryAfterMs === 'number') {
    result.headers = { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
  }
  return result;
}

export function okResult(body: unknown): DeviceResult {
  return { status: 200, body };
}

/** 426 unless `x-ordr-api-version` is exactly "1" (SYNC §6). */
export function versionGate(headers: Headers): DeviceResult | null {
  if (headers.get(API_VERSION_HEADER) === String(API_VERSION)) return null;
  return errorResult(426, 'upgrade_required', `${API_VERSION_HEADER} must be ${API_VERSION}`, { min_api_version: API_VERSION });
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+(%[0-9a-z]+)?$/i;

/** An IPv4 / IPv6 literal (port / brackets stripped), lowercased; else null. */
export function parseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  // "[::1]:1234" / "1.2.3.4:5678" → host only
  const bracket = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) v = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.split(':')[0];
  if (IPV4.test(v)) return v;
  if (v.includes(':') && IPV6.test(v) && (v.match(/:/g)?.length ?? 0) >= 2) return v.toLowerCase();
  return null;
}

/** Which header the caller IP came from (logged instead of the IP itself). */
export type IpSource = 'cf-connecting-ip' | 'x-real-ip' | 'x-forwarded-for' | 'none';

/**
 * Caller IP for rate limiting. Order (CP5b):
 *   cf-connecting-ip → x-real-ip → x-forwarded-for FIRST hop (last resort) → none.
 * The first x-forwarded-for hop is client-controlled (a caller can prepend any value), so it is only
 * used when the proxy-set headers are absent. Each candidate must parse as an IP or the next one is
 * tried. `none` → the caller lands in the shared 0.0.0.0 bucket (register.ts UNKNOWN_IP).
 * VERIFY ON DEPLOY which of these the Supabase edge gateway actually sets.
 */
export function callerIpWithSource(headers: Headers): { ip: string | null; source: IpSource } {
  const cf = parseIp(headers.get('cf-connecting-ip'));
  if (cf) return { ip: cf, source: 'cf-connecting-ip' };
  const real = parseIp(headers.get('x-real-ip'));
  if (real) return { ip: real, source: 'x-real-ip' };
  const xff = parseIp(headers.get('x-forwarded-for')?.split(',')[0]);
  if (xff) return { ip: xff, source: 'x-forwarded-for' };
  return { ip: null, source: 'none' };
}

/** callerIpWithSource(...).ip */
export function callerIp(headers: Headers): string | null {
  return callerIpWithSource(headers).ip;
}

/** Parse a JSON object body. */
export function parseJsonObject(bodyText: string): { ok: true; value: Record<string, unknown> } | { ok: false; result: DeviceResult } {
  let v: unknown;
  try {
    v = bodyText.trim() === '' ? {} : JSON.parse(bodyText);
  } catch {
    return { ok: false, result: errorResult(400, 'invalid_payload', 'body is not valid JSON') };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, result: errorResult(400, 'invalid_payload', 'body must be a JSON object') };
  }
  return { ok: true, value: v as Record<string, unknown> };
}

export function toResponse(r: DeviceResult, cors: Record<string, string> = DEVICE_CORS_HEADERS): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { ...cors, ...(r.headers ?? {}), 'Content-Type': 'application/json' },
  });
}

/** Read at most `max` bytes; null if larger. */
export async function readBodyLimited(req: Request, max = MAX_DEVICE_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Shared front door for every device function: OPTIONS, POST only, the 426 version gate, the body
 * cap, then `handler`. Any throw → 500 `internal_error` with a generic message (the error is logged
 * by `logError`, which must never receive secrets).
 */
export async function handleDeviceHttp(
  req: Request,
  handler: (r: DeviceRequest) => Promise<DeviceResult>,
  logError: (msg: string) => void,
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: DEVICE_CORS_HEADERS });
  if (req.method !== 'POST') return toResponse(errorResult(405, 'method_not_allowed', 'POST only'));
  const gate = versionGate(req.headers);
  if (gate) return toResponse(gate);
  const bodyText = await readBodyLimited(req);
  if (bodyText === null) return toResponse(errorResult(400, 'invalid_payload', `body exceeds ${MAX_DEVICE_BODY_BYTES} bytes`));
  try {
    const { ip, source } = callerIpWithSource(req.headers);
    return toResponse(await handler({ method: req.method, headers: req.headers, bodyText, ip, ipSource: source }));
  } catch (err) {
    logError(err instanceof Error ? `${err.name}: ${err.message}` : 'non-error thrown');
    return toResponse(errorResult(500, 'internal_error', 'Something went wrong. Please try again.'));
  }
}
