/**
 * Test harness: the in-memory store + a controllable clock + the real handlers.
 * Admin codes are created through handleAdmin (the same path /admin uses).
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { handleAdmin } from '../admin.ts';
import { handleDeviceCheck } from '../deviceCheck.ts';
import type { DeviceLog } from '../log.ts';
import { handleRegister } from '../register.ts';
import { MemoryDeviceStore } from '../store.ts';
import type { DeviceResult } from '../../pos-sync/http.ts';

export const R1 = '11111111-1111-4111-8111-111111111111';
export const R2 = '22222222-2222-4222-8222-222222222222';
export const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const FAKE_IP = '203.0.113.7';
export const INVALID = { status: 400, code: 'enrollment_invalid', message: 'Code invalid or expired' };

export class TestClock {
  t = Date.parse('2026-11-19T17:00:00Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function err(r: DeviceResult): { status: number; code?: string; message?: string } {
  const e = (r.body as { error?: { code: string; message: string } })?.error;
  return e ? { status: r.status, code: e.code, message: e.message } : { status: r.status };
}

export function ok<T = Record<string, unknown>>(r: DeviceResult): T {
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body as T;
}

export interface Registered {
  device_id: string;
  device_token: string;
  restaurant_id: string;
  prefix: string;
  label: string;
  server_time: string;
}

export function harness() {
  const clock = new TestClock();
  const store = new MemoryDeviceStore();
  const logs: string[] = [];
  const log: DeviceLog = (event, data = {}) => logs.push(JSON.stringify({ event, ...data }));
  const deps = { store, now: clock.now, log };

  async function admin(body: Record<string, unknown>, auth: 'admin' | 'none' | 'other' = 'admin') {
    return await handleAdmin(
      { method: 'POST', headers: new Headers({ authorization: auth === 'none' ? '' : 'Bearer x' }), bodyText: JSON.stringify(body) },
      {
        ...deps,
        verifyAdmin: (h) => Promise.resolve(auth === 'admin' && h ? { ok: true, adminId: ADMIN } : { ok: false, status: auth === 'none' ? 401 : 403 }),
      },
    );
  }

  /** Add register / re-enroll → { code (10 chars), display, prefix, label, expires_at }. */
  async function enroll(o: { restaurantId?: string; label?: string; targetDeviceId?: string } = {}) {
    const r = ok<{ code: string; qr: string; prefix: string; label: string; expires_at: string; enrollment_id: string }>(
      await admin(o.targetDeviceId
        ? { action: 'create_reenrollment', restaurant_id: o.restaurantId ?? R1, device_id: o.targetDeviceId, label: o.label }
        : { action: 'create_enrollment', restaurant_id: o.restaurantId ?? R1, label: o.label }),
    );
    return { ...r, display: r.code, code: r.code.replace('-', '') };
  }

  const req = (code: string, o: Record<string, unknown> = {}) => ({
    enrollment_code: code,
    registration_nonce: crypto.randomUUID(),
    existing_device_id: null,
    hardware_model: 'iMin Swan 3 Pro',
    app_version: '1.0.0',
    ...o,
  });

  async function register(body: unknown, ip: string | null = FAKE_IP) {
    return await handleRegister({ method: 'POST', headers: new Headers(), bodyText: typeof body === 'string' ? body : JSON.stringify(body), ip }, deps);
  }

  async function check(h: Record<string, string>, body: Record<string, unknown> = {}) {
    return await handleDeviceCheck({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', 'x-ordr-client': 'ordr-pos/1.0.0', ...h }), bodyText: JSON.stringify(body), ip: FAKE_IP }, deps);
  }

  const asDevice = (d: { device_id: string; device_token: string }) => ({ 'x-ordr-device-id': d.device_id, 'x-ordr-device-token': d.device_token });

  return { clock, store, logs, deps, admin, enroll, req, register, check, asDevice };
}
