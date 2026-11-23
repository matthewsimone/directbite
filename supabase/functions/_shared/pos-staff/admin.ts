/**
 * scripts/pos-staff.ts commands (handoff item 8; STAFF.md S5). IO and the store are injected so tests
 * run every command without a database or a terminal.
 *
 *   add <restaurant-slug> <name> <role>      role: manager | staff (driver is reserved — refused)
 *   set-pin <staff-id>
 *   deactivate <staff-id>
 *   reactivate <staff-id>                     (no-op when already active)
 *   list <restaurant-slug>                    names / roles / active only — never salts or hashes
 *   settings <restaurant-slug> [--auto-lock N] [--over-short-cents N] [--z-requires-manager true|false]
 *
 * PIN: 4–6 digits (the POS's PIN_PATTERN), typed twice, never echoed / logged / stored; weak PINs warn +
 * confirm, never refuse. New 16-byte salt per set; scrypt with the restaurant's pin_kdf; the shared test
 * vector is checked before the first hash. After each change the new staff snapshot is published.
 */
import { currentStaffSnapshot } from './handlers.ts';
import { isValidPin, newSaltHex, pinHashHex, selfCheck, weakPinReason } from './pin.ts';
import { hasActiveManager, StaffConfigError, type StaffRole } from './snapshot.ts';
import type { AdminResult, StaffAdminStore, StaffStore } from './store.ts';

export interface AdminIO {
  out(line: string): void;
  /** Hidden input (no echo). */
  promptPin(label: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface AdminDeps {
  store: StaffAdminStore & StaffStore;
  io: AdminIO;
  now: () => number;
}

export const USAGE = [
  'usage:',
  '  pos-staff add <restaurant-slug> <name> <manager|staff>',
  '  pos-staff set-pin <staff-id>',
  '  pos-staff deactivate <staff-id>',
  '  pos-staff reactivate <staff-id>',
  '  pos-staff list <restaurant-slug>',
  '  pos-staff settings <restaurant-slug> [--auto-lock N] [--over-short-cents N] [--z-requires-manager true|false]',
].join('\n');

const REASONS: Record<Exclude<AdminResult, { ok: true }>['reason'], string> = {
  not_found: 'not found',
  last_active_manager: 'refused: this would leave the restaurant without an active manager (PINs are on)',
  kdf_changed: "refused: the restaurant's pin_kdf changed while hashing — run the command again",
  invalid: 'refused: invalid input',
};

/** Ask for a PIN twice; null when invalid / mismatched / a weak PIN is not confirmed. */
async function askPin(io: AdminIO): Promise<string | null> {
  const pin = await io.promptPin('PIN (4–6 digits): ');
  if (!isValidPin(pin)) {
    io.out('PIN must be 4–6 digits.');
    return null;
  }
  const again = await io.promptPin('PIN again: ');
  if (again !== pin) {
    io.out('The two PINs differ.');
    return null;
  }
  const weak = weakPinReason(pin);
  if (weak && !(await io.confirm(`Warning: weak PIN (${weak}). Use it anyway?`))) {
    io.out('Cancelled.');
    return null;
  }
  return pin;
}

async function publish(deps: AdminDeps, restaurantId: string): Promise<number> {
  try {
    const s = await currentStaffSnapshot(deps.store, restaurantId, deps.now());
    if (s) deps.io.out(`Published staff snapshot v${s.version} (${s.staff.length} staff${hasActiveManager(s.staff) ? '' : ', NO active manager yet — registers stay in register mode'}).`);
    return 0;
  } catch (err) {
    if (err instanceof StaffConfigError) {
      deps.io.out(`Saved, but the snapshot can't be published: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function result(io: AdminIO, r: AdminResult): boolean {
  if (r.ok) return true;
  io.out(REASONS[r.reason]);
  return false;
}

function intFlag(v: string | undefined, name: string, min: number, max: number): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`${name} must be an integer ${min}–${max}`);
  return Number(v);
}

class UsageError extends Error {}

/** Runs one command; returns the process exit code (0 ok, 1 refused / failed, 2 usage). */
export async function runPosStaff(argv: string[], deps: AdminDeps): Promise<number> {
  const { io, store } = deps;
  const [cmd, ...a] = argv;
  try {
    switch (cmd) {
      case 'add': {
        if (a.length !== 3) throw new UsageError('add needs <restaurant-slug> <name> <role>');
        const [slug, rawName, role] = a;
        const name = rawName.trim();
        if (name.length < 1 || name.length > 60) throw new UsageError('name must be 1–60 characters');
        if (role === 'driver') throw new UsageError('role driver is reserved (not usable yet)');
        if (role !== 'manager' && role !== 'staff') throw new UsageError('role must be manager or staff');
        const r = await store.restaurantBySlug(slug);
        if (!r) return (io.out(`No restaurant with slug ${slug}.`), 1);
        selfCheck();
        const kdf = (await store.settings(r.id)).pin_kdf;
        const pin = await askPin(io);
        if (pin === null) return 1;
        const salt = newSaltHex();
        const res = await store.add(r.id, name, role as StaffRole, salt, pinHashHex(pin, salt, kdf), kdf);
        if (!result(io, res)) return 1;
        io.out(`Added ${name} (${role}) to ${r.name}: ${(res as { staff_id: string }).staff_id}`);
        return await publish(deps, r.id);
      }
      case 'set-pin': {
        if (a.length !== 1) throw new UsageError('set-pin needs <staff-id>');
        const s = await store.staffById(a[0]);
        if (!s) return (io.out('No staff with that id.'), 1);
        selfCheck();
        const kdf = (await store.settings(s.restaurant_id)).pin_kdf;
        io.out(`New PIN for ${s.name} (${s.role}${s.active ? '' : ', inactive'}).`);
        const pin = await askPin(io);
        if (pin === null) return 1;
        const salt = newSaltHex();
        if (!result(io, await store.setPin(s.id, salt, pinHashHex(pin, salt, kdf), kdf))) return 1;
        io.out(`PIN set for ${s.name}.`);
        return await publish(deps, s.restaurant_id);
      }
      case 'deactivate': {
        if (a.length !== 1) throw new UsageError('deactivate needs <staff-id>');
        const s = await store.staffById(a[0]);
        if (!s) return (io.out('No staff with that id.'), 1);
        if (!result(io, await store.deactivate(s.id))) return 1;
        io.out(`Deactivated ${s.name}.`);
        return await publish(deps, s.restaurant_id);
      }
      case 'reactivate': {
        if (a.length !== 1) throw new UsageError('reactivate needs <staff-id>');
        const s = await store.staffById(a[0]);
        if (!s) return (io.out('No staff with that id.'), 1);
        if (s.active) return (io.out(`${s.name} is already active.`), 0);
        if (!result(io, await store.reactivate(s.id))) return 1;
        io.out(`Reactivated ${s.name} (${s.role}).`);
        return await publish(deps, s.restaurant_id);
      }
      case 'list': {
        if (a.length !== 1) throw new UsageError('list needs <restaurant-slug>');
        const r = await store.restaurantBySlug(a[0]);
        if (!r) return (io.out(`No restaurant with slug ${a[0]}.`), 1);
        const rows = await store.list(r.id);
        io.out(`${r.name}: ${rows.length} staff`);
        for (const s of rows) io.out(`  ${s.sort_order}. ${s.name} — ${s.role}${s.active ? '' : ' (inactive)'} — ${s.id}`);
        return 0;
      }
      case 'settings': {
        if (a.length < 1) throw new UsageError('settings needs <restaurant-slug>');
        const [slug, ...flags] = a;
        const patch: { auto_lock_minutes?: number; over_short_approval_cents?: number; z_requires_manager?: boolean } = {};
        for (let i = 0; i < flags.length; i += 2) {
          const [k, v] = [flags[i], flags[i + 1]];
          if (k === '--auto-lock') patch.auto_lock_minutes = intFlag(v, '--auto-lock', 0, 240);
          else if (k === '--over-short-cents') patch.over_short_approval_cents = intFlag(v, '--over-short-cents', 0, 1_000_000);
          else if (k === '--z-requires-manager') {
            if (v !== 'true' && v !== 'false') throw new UsageError('--z-requires-manager must be true or false');
            patch.z_requires_manager = v === 'true';
          } else throw new UsageError(`unknown option ${k}`);
        }
        const r = await store.restaurantBySlug(slug);
        if (!r) return (io.out(`No restaurant with slug ${slug}.`), 1);
        if (Object.keys(patch).length === 0) {
          const s = await store.settings(r.id);
          io.out(`${r.name}: auto_lock_minutes ${s.auto_lock_minutes}, over_short_approval_cents ${s.over_short_approval_cents}, z_requires_manager ${s.z_requires_manager}, pin_kdf scrypt n ${s.pin_kdf.n} r ${s.pin_kdf.r} p ${s.pin_kdf.p} dk_len ${s.pin_kdf.dk_len}`);
          return 0;
        }
        if (!result(io, await store.setSettings(r.id, patch))) return 1;
        io.out(`Settings updated for ${r.name}.`);
        return await publish(deps, r.id);
      }
      default:
        throw new UsageError(cmd ? `unknown command ${cmd}` : 'no command');
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.out(`${err.message}\n${USAGE}`);
      return 2;
    }
    throw err;
  }
}
