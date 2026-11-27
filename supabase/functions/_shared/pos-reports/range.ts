/**
 * Owner Reports v1 — the report's business days. Presets resolve on the restaurant's BUSINESS day
 * (restaurants.timezone, 04:00 cutoff — the POS's businessDate, pos-eod/rules.ts :16), never the caller's clock or
 * New York midnight (the web's getRangeForPreset, src/utils/scheduling.js :255, is calendar-day based). Pure.
 */
import { businessDate } from '../pos-eod/rules.ts';
import { addDays } from '../pos-online/feedQuery.ts';
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';

export const MAX_RANGE_DAYS = 93;
export const PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth'] as const;
export type Preset = typeof PRESETS[number];

export interface ReportRange {
  from: string;
  to: string;
  /** The restaurant's current business day. */
  today: string;
  preset: Preset | null;
  /** from … to, oldest first. */
  days: string[];
}

export type RangeResult = { ok: true; range: ReportRange } | { ok: false; field: string; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && addDays(v, 0) === v;
const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;

/** Inclusive day count from → to (both real dates, from ≤ to). */
function span(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function presetRange(p: Preset, today: string): { from: string; to: string } {
  switch (p) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last30': return { from: addDays(today, -29), to: today };
    case 'thisMonth': return { from: firstOfMonth(today), to: today };
    case 'lastMonth': {
      const end = addDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(end), to: end };
    }
  }
}

/** { preset } or { from, to } (business dates, YYYY-MM-DD). `to` may not be after today; at most 93 days. */
export function resolveRange(input: { preset?: unknown; from?: unknown; to?: unknown }, nowMs: number, timeZone: string, cutoff: string = BUSINESS_DAY_CUTOFF): RangeResult {
  const today = businessDate(nowMs, timeZone, cutoff);
  let from: string;
  let to: string;
  let preset: Preset | null = null;
  if (input.preset !== undefined && input.preset !== null) {
    if (input.from !== undefined || input.to !== undefined) return { ok: false, field: 'preset', message: 'send preset OR from + to, not both' };
    if (!(PRESETS as readonly unknown[]).includes(input.preset)) return { ok: false, field: 'preset', message: `preset must be one of ${PRESETS.join(', ')}` };
    preset = input.preset as Preset;
    ({ from, to } = presetRange(preset, today));
  } else {
    if (!realDate(input.from)) return { ok: false, field: 'from', message: 'from must be a real YYYY-MM-DD business date' };
    if (!realDate(input.to)) return { ok: false, field: 'to', message: 'to must be a real YYYY-MM-DD business date' };
    from = input.from;
    to = input.to;
    if (from > to) return { ok: false, field: 'from', message: 'from must be on or before to' };
    if (to > today) return { ok: false, field: 'to', message: `to is after today's business day (${today})` };
  }
  if (span(from, to) > MAX_RANGE_DAYS) return { ok: false, field: 'to', message: `at most ${MAX_RANGE_DAYS} days` };
  return { ok: true, range: { from, to, today, preset, days: daysBetween(from, to) } };
}
