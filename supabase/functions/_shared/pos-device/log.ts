/**
 * Structured logging for device functions. Callers pass ids, codes and `token_hash[:8]` only —
 * never a token, an enrollment code or its secret (DEVICE-AUTH §3). As a last line of defence,
 * anything shaped like a device token is masked before it is written.
 */
export type DeviceLog = (event: string, data?: Record<string, unknown>) => void;

const TOKEN = /odt_[A-Za-z0-9_-]*/g;

export function redact(s: string): string {
  return s.replace(TOKEN, '[device token]');
}

export function consoleDeviceLog(fn: string): DeviceLog {
  return (event, data = {}) => {
    try {
      console.log(redact(JSON.stringify({ fn, event, ...data })));
    } catch {
      // a broken logger must never break a request
    }
  };
}
