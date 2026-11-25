/**
 * PORT of the reference print rules — ordr-pos @ 7798d52 src/dev/onlinePrintRules.ts (orderPrintResult :46-51,
 * applyClaim :54-61, applyPrintResult :63-98), byte-for-byte in behaviour, with the wire types it needs
 * (src/sync/onlineContract.ts :186-236, :672-680) declared here.
 *
 * Used by: the handler (tabletWrite: the tablet's print columns from the order's result after a station result)
 * and the tests (the oracle MemoryOnlineStore — the mirror of migration 110's SQL — is checked against).
 * The SQL (110 pos_claim_online_print / pos_record_online_print) is the station path of these rules; the
 * reference's no-station branch (:85-90, "a register before station routing") is NOT served: every register at
 * 7798d52 sends a station, and pos-v1-online-print answers 400 invalid_payload without one (deviation, listed).
 */

export const UNCONFIRMED_ERROR = 'printer did not confirm';

export type PrintResult = 'printed' | 'printed_unconfirmed' | 'failed';
export type PrintVariant = 'auto' | 'manual' | 'reprint';

export interface OnlineStationRef {
  station: string;
  name: string;
  lines: number[];
}
export interface OnlineStationPrint extends OnlineStationRef {
  result: PrintResult | null;
  printed_at: string | null;
}
export interface OnlinePrintAttempt {
  at: string;
  device_id: string | null;
  variant: PrintVariant;
  result: PrintResult;
  error: string | null;
  station: string | null;
}
export interface OnlinePrintWire {
  stations: OnlineStationPrint[];
  claimed_by_device_id: string | null;
  claimed_at: string | null;
  result: PrintResult | null;
  printed_at: string | null;
  attempts: OnlinePrintAttempt[];
  print_status: 'pending' | 'printed' | 'failed' | null;
  print_attempts: number;
}

/** What the tablet's columns get after one result (reference TabletPrintWrite :31-39). */
export interface TabletPrintWrite {
  /** The print_logs row's status (success only when printed). */
  ok: boolean;
  error: string | null;
  /** handleReprint: only the print_logs row. */
  logOnly: boolean;
  /** print_status to write (null = leave it: other stations are still printing). */
  printStatus: 'printed' | 'failed' | null;
}

type PrintOf = { print: OnlinePrintWire; status: string };

const station = (s: OnlineStationRef): OnlineStationPrint => ({ station: s.station, name: s.name, lines: [...s.lines], result: null, printed_at: null });

/** The order's outcome over its stations (null while any is still printing). Reference :46-51. */
export function orderPrintResult(stations: readonly Pick<OnlineStationPrint, 'result'>[]): PrintResult | null {
  if (!stations.length) return null;
  if (stations.some((s) => s.result === 'failed')) return 'failed';
  if (stations.some((s) => s.result === 'printed_unconfirmed')) return 'printed_unconfirmed';
  return stations.every((s) => s.result === 'printed') ? 'printed' : null;
}

/** op `claim` (designation + flag checked by the caller). true = this call claimed it. Reference :54-61. */
export function applyClaim(w: PrintOf, deviceId: string, req: { stations: OnlineStationRef[] | null }, nowIso: string): boolean {
  const p = w.print;
  if (p.claimed_by_device_id !== null || p.result !== null || p.print_status === 'printed') return false;
  p.claimed_by_device_id = deviceId;
  p.claimed_at = nowIso;
  p.stations = (req.stations ?? []).map(station);
  return true;
}

/** Reference :63-98 (all branches, including the no-station one the server does not serve). */
export function applyPrintResult(
  w: PrintOf,
  deviceId: string,
  req: { variant: PrintVariant | null; result: PrintResult | null; error: string | null; station: OnlineStationRef | null },
  nowIso: string,
  printTrigger: 'received' | 'in_progress',
): TabletPrintWrite {
  const p = w.print;
  const result = req.result!;
  const variant = req.variant!;
  p.attempts.push({ at: nowIso, device_id: deviceId, variant, result, error: req.error, station: req.station?.station ?? null });
  if (variant === 'manual' && p.claimed_by_device_id === null) {
    p.claimed_by_device_id = deviceId;
    p.claimed_at = nowIso;
  }
  if (req.station) {
    let st = p.stations.find((s) => s.station === req.station!.station);
    if (!st) {
      st = station(req.station);
      p.stations.push(st);
    }
    if (result === 'printed') {
      st.result = 'printed';
      st.printed_at = nowIso;
    } else if (variant === 'auto' && p.claimed_by_device_id === deviceId && st.result !== 'printed') st.result = result;
    else if (variant !== 'reprint' && st.result === null) st.result = result;
    p.result = orderPrintResult(p.stations);
    if (p.result === 'printed') p.printed_at = nowIso;
  } else if (result === 'printed') {
    p.result = 'printed';
    p.printed_at = nowIso;
  } else if (variant === 'auto' && p.claimed_by_device_id === deviceId && p.result !== 'printed') p.result = result;
  else if (variant !== 'reprint' && p.result === null) p.result = result;
  return tabletWrite({ variant, result, error: req.error }, p.result, printTrigger, w.status);
}

/**
 * The tablet-column part of applyPrintResult (:91-97) from the ORDER's result after this station result —
 * the server computes it from what pos_record_online_print returns.
 */
export function tabletWrite(
  req: { variant: PrintVariant; result: PrintResult; error: string | null },
  orderResult: PrintResult | null,
  printTrigger: 'received' | 'in_progress',
  orderStatus: string,
): TabletPrintWrite {
  const ok = req.result === 'printed';
  return {
    ok,
    error: ok ? null : req.result === 'printed_unconfirmed' ? UNCONFIRMED_ERROR : (req.error ?? 'did not print'),
    logOnly: req.variant === 'reprint' && printTrigger === 'in_progress' && orderStatus === 'new',
    printStatus: orderResult === 'printed' ? 'printed' : orderResult === 'failed' || orderResult === 'printed_unconfirmed' ? 'failed' : null,
  };
}
