/**
 * Item 4: the loader now uses the vendored ordr-pos availability.ts instead of the removed
 * _shared/pos-v1/categoryWindow.ts. Same verdict on every blob × instant below (incl. malformed
 * blobs, partial times, overnight windows, seconds, DST days) → price-order / shadow behavior is
 * unchanged (golden + shadow tests also pass).
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { isCategoryAvailableAt, normalizeAvailability } from '../../ordr-core-ext/availability.ts';
import { isCategoryAvailableAt as legacy } from './categoryWindow.legacy.ts';

const BLOBS: unknown[] = [
  null, undefined, 42, 'x', [], {}, { '1': null }, { '9': { enabled: true } },
  { '4': { enabled: true } },
  { '4': { enabled: true, start: '11:00', end: '15:00' } },
  { '4': { enabled: true, start: '11:00:00', end: '15:00:59' } },
  { '4': { enabled: true, start: '11:00', end: '' } },
  { '4': { enabled: true, start: '', end: '15:00' } },
  { '4': { enabled: true, start: '22:00', end: '02:00' } },
  { '4': { enabled: false, start: '11:00', end: '15:00' }, '5': { enabled: true } },
  { '4': { enabled: true, start: '25:00', end: '15:00' } },
  { '4': { enabled: true, start: 1100, end: '15:00' } },
  { '4': 'yes' },
  { '0': { enabled: true, start: '00:00', end: '23:59' }, '4': { enabled: true, start: '12:00', end: '12:00' } },
  { '1': { enabled: true, start: '09:00', end: '17:00' } },
];
const INSTANTS = [
  '2026-11-19T16:00:00Z', '2026-11-19T17:00:00Z', '2026-11-19T17:00:59Z', '2026-11-19T20:00:00Z', '2026-11-19T20:01:00Z',
  '2026-11-20T03:30:00Z', '2026-11-20T06:30:00Z', '2026-11-22T05:00:00Z', '2026-03-08T07:30:00Z', '2026-11-01T06:30:00Z',
];

Deno.test('vendored availability.ts == removed categoryWindow.ts on every blob × instant × zone', () => {
  let n = 0;
  for (const tz of ['America/New_York', 'America/Los_Angeles']) {
    for (const b of BLOBS) {
      for (const iso of INSTANTS) {
        const at = new Date(iso);
        assertEquals(isCategoryAvailableAt(normalizeAvailability(b), at.getTime(), tz), legacy(b, at, tz), `${JSON.stringify(b)} @ ${iso} ${tz}`);
        n++;
      }
    }
  }
  assertEquals(n, 400);
});
