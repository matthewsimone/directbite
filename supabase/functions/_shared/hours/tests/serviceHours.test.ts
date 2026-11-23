/**
 * Server service hours (CP8): parity with src/utils/serviceHours.js + scheduling.js, evaluated in
 * the restaurant's timezone (incl. both 2026 US DST transitions) instead of the browser's.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import {
  checkSlot,
  getEffectiveSchedule,
  isOpenAt,
  localTime,
  normalizeSchedule,
  OPEN_BUFFER_MINUTES,
  type Schedule,
  scheduleFromHours,
} from '../serviceHours.ts';

const NY = 'America/New_York';
const every = (start: string, end: string): Schedule => Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((k) => [k, [{ start, end }]]));
const at = (iso: string) => new Date(iso);

Deno.test('normalizeSchedule: web rules (enabled days only, ≤ 2 windows, no overlap, start < end; one bad day → null)', () => {
  assertEquals(normalizeSchedule({ '3': { enabled: true, windows: [{ start: '16:30', end: '20:30' }, { start: '11:30', end: '15:15' }] } })!['3'], [
    { start: '11:30', end: '15:15' },
    { start: '16:30', end: '20:30' },
  ]);
  assertEquals(normalizeSchedule({ '1': { enabled: false, windows: [{ start: '09:00', end: '10:00' }] } })!['1'], []);
  assertEquals(normalizeSchedule({ '1': { enabled: true, windows: [{ start: '09:00', end: '12:00' }, { start: '12:00', end: '13:00' }] } })!['1'].length, 2, 'touching windows ok');
  for (const bad of [
    { '1': { enabled: true, windows: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } },
    { '1': { enabled: true, windows: [{ start: '12:00', end: '12:00' }] } },
    { '1': { enabled: true, windows: [{ start: '9:00', end: '12:00' }] } },
    { '1': { enabled: true, windows: [1, 2, 3] } },
    { '1': 'yes' },
    [],
    null,
  ]) assertEquals(normalizeSchedule(bad), null, JSON.stringify(bad));
});

Deno.test('scheduleFromHours: first row per day, closed / unparseable / close ≤ open → [], 24:00 → 23:59, no rows → null', () => {
  const s = scheduleFromHours([
    { day_of_week: 1, is_open: true, open_time: '11:00:00', close_time: '22:00:00' },
    { day_of_week: 1, is_open: true, open_time: '05:00:00', close_time: '06:00:00' },
    { day_of_week: 2, is_open: false, open_time: '11:00:00', close_time: '22:00:00' },
    { day_of_week: 3, is_open: true, open_time: '22:00:00', close_time: '02:00:00' },
    { day_of_week: 4, is_open: true, open_time: '17:00:00', close_time: '24:00:00' },
  ])!;
  assertEquals([s['1'], s['2'], s['3'], s['4'], s['0']], [[{ start: '11:00', end: '22:00' }], [], [], [{ start: '17:00', end: '23:59' }], []]);
  assertEquals(scheduleFromHours([]), null);
  assertEquals(scheduleFromHours(null), null);
});

Deno.test('getEffectiveSchedule: pickup = pickup_schedule ?? hours; delivery = delivery_schedule ?? pickup; an invalid blob counts as unset', () => {
  const hours = [{ day_of_week: 4, is_open: true, open_time: '11:00:00', close_time: '22:00:00' }];
  const pickupBlob = { '4': { enabled: true, windows: [{ start: '12:00', end: '14:00' }] } };
  assertEquals(getEffectiveSchedule({}, hours, 'pickup')!['4'], [{ start: '11:00', end: '22:00' }]);
  assertEquals(getEffectiveSchedule({ pickup_schedule: pickupBlob }, hours, 'pickup')!['4'], [{ start: '12:00', end: '14:00' }]);
  assertEquals(getEffectiveSchedule({ pickup_schedule: pickupBlob }, hours, 'delivery')!['4'], [{ start: '12:00', end: '14:00' }], 'delivery falls back to pickup');
  assertEquals(getEffectiveSchedule({ pickup_schedule: { '4': 'bad' } }, hours, 'pickup')!['4'], [{ start: '11:00', end: '22:00' }], 'invalid → hours');
  assertEquals(getEffectiveSchedule({}, [], 'delivery'), null);
});

Deno.test('isOpenAt: inclusive at open AND close, whole seconds (close 20:30 → open 20:30:00, closed 20:30:01); null schedule = closed', () => {
  const s = every('11:00', '20:30');
  // 2026-11-19 is a Thursday; EST = UTC-5
  assertEquals(isOpenAt(s, at('2026-11-19T15:59:59Z'), NY), false); // 10:59:59
  assertEquals(isOpenAt(s, at('2026-11-19T16:00:00Z'), NY), true); // 11:00:00
  assertEquals(isOpenAt(s, at('2026-11-20T01:30:00Z'), NY), true); // 20:30:00
  assertEquals(isOpenAt(s, at('2026-11-20T01:30:01Z'), NY), false); // 20:30:01
  assertEquals(isOpenAt(null, at('2026-11-19T17:00:00Z'), NY), false);
  // the restaurant's zone decides, not the browser's: 17:00Z is noon in NY but 9:00 in LA
  assertEquals([isOpenAt(s, at('2026-11-19T17:00:00Z'), NY), isOpenAt(s, at('2026-11-19T17:00:00Z'), 'America/Los_Angeles')], [true, false]);
});

Deno.test('DST: wall-clock windows follow the zone across spring-forward (2026-03-08) and fall-back (2026-11-01)', () => {
  const s = every('11:00', '21:00');
  // Sunday before spring-forward, EST (UTC-5): 15:30Z = 10:30 closed, 16:00Z = 11:00 open
  assertEquals([isOpenAt(s, at('2026-03-01T15:30:00Z'), NY), isOpenAt(s, at('2026-03-01T16:00:00Z'), NY)], [false, true]);
  // spring-forward Sunday, EDT (UTC-4): 15:00Z = 11:00 open, 14:59Z = 10:59 closed
  assertEquals([isOpenAt(s, at('2026-03-08T14:59:00Z'), NY), isOpenAt(s, at('2026-03-08T15:00:00Z'), NY)], [false, true]);
  assertEquals(localTime(at('2026-03-08T15:00:00Z'), NY), { date: '2026-03-08', dow: 0, sec: 11 * 3600 });
  // close: 21:00 EDT = 01:00Z next day
  assertEquals([isOpenAt(s, at('2026-03-09T01:00:00Z'), NY), isOpenAt(s, at('2026-03-09T01:00:01Z'), NY)], [true, false]);
  // fall-back Sunday (EST again): 15:30Z = 10:30 closed, 16:00Z = 11:00 open
  assertEquals([isOpenAt(s, at('2026-11-01T15:30:00Z'), NY), isOpenAt(s, at('2026-11-01T16:00:00Z'), NY)], [false, true]);
  // the repeated 01:xx hour on fall-back night maps to Sunday 01:30 both times
  assertEquals([localTime(at('2026-11-01T05:30:00Z'), NY).sec, localTime(at('2026-11-01T06:30:00Z'), NY).sec], [5400, 5400]);
  // a scheduled slot on the spring-forward day: 11:30 EDT = 15:30Z (buffer satisfied)
  assertEquals(checkSlot(s, at('2026-03-08T15:30:00Z'), at('2026-03-07T17:00:00Z'), NY), 'ok');
  assertEquals(checkSlot(s, at('2026-03-08T15:29:00Z'), at('2026-03-07T17:00:00Z'), NY), 'outside_hours');
});

Deno.test(`checkSlot: ≥ window start + ${OPEN_BUFFER_MINUTES} min (the web's open buffer), ≤ window end, today..+6 local days, not in the past`, () => {
  const s = every('11:00', '21:00');
  const now = at('2026-11-19T17:00:00Z'); // Thu 12:00 NY
  assertEquals(checkSlot(s, at('2026-11-20T16:29:00Z'), now, NY), 'outside_hours'); // Fri 11:29
  assertEquals(checkSlot(s, at('2026-11-20T16:30:00Z'), now, NY), 'ok'); // Fri 11:30
  assertEquals(checkSlot(s, at('2026-11-21T02:00:00Z'), now, NY), 'ok'); // Fri 21:00
  assertEquals(checkSlot(s, at('2026-11-21T02:01:00Z'), now, NY), 'outside_hours'); // Fri 21:01
  assertEquals(checkSlot(s, at('2026-11-25T23:00:00Z'), now, NY), 'ok'); // Wed (+6 days) 18:00
  assertEquals(checkSlot(s, at('2026-11-26T23:00:00Z'), now, NY), 'too_far'); // Thu (+7 days) 18:00
  assertEquals(checkSlot(s, at('2026-11-19T16:59:00Z'), now, NY), 'past');
  assertEquals(checkSlot(s, at('2026-11-19T23:00:00Z'), now, NY), 'ok', 'later today, no lead-time floor (the page may have sat open)');
  // second window of a split day
  const split: Schedule = { ...every('11:00', '21:00'), '5': [{ start: '11:00', end: '14:00' }, { start: '17:00', end: '21:00' }] };
  assertEquals(checkSlot(split, at('2026-11-20T20:00:00Z'), now, NY), 'outside_hours'); // Fri 15:00 (gap)
  assertEquals(checkSlot(split, at('2026-11-20T22:15:00Z'), now, NY), 'outside_hours'); // Fri 17:15 (< 17:30 buffer)
  assertEquals(checkSlot(split, at('2026-11-20T22:30:00Z'), now, NY), 'ok'); // Fri 17:30
  // a closed day
  const closedFri: Schedule = { ...every('11:00', '21:00'), '5': [] };
  assertEquals(checkSlot(closedFri, at('2026-11-20T23:00:00Z'), now, NY), 'outside_hours');
  assertEquals(checkSlot(null, at('2026-11-20T23:00:00Z'), now, NY), 'no_schedule');
});
