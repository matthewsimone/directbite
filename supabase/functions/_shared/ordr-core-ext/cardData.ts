/**
 * Card-data guard (EXTERNAL CARD TENDER). The POS never stores a card number,
 * expiry, CVV or track data — not in payments, notes, reasons, logs or the
 * outbox. Anything that looks like a primary account number is rejected
 * before it is written (repo) and again on the server (submit-order 400
 * `card_data_rejected`).
 *
 * "Looks like a PAN": a run of 13 or more digits, either contiguous or split
 * into groups of 3+ digits by single spaces / dashes ("4111 1111 1111 1111",
 * "3782-822463-10005"). Groups of 1–2 digits ("12 13 14 15 16 17 18") and
 * shorter numbers (phones: 10–11 digits) are fine. 20+ digits are rejected too
 * (they contain a 13–19 digit run). Pure; shared with directbite later.
 */
const RUN = /\d+(?:[ -]\d+)*/g;
const MIN_PAN_DIGITS = 13;

export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(RUN)) {
    const groups = m[0].split(/[ -]/);
    // Only digits joined by separators between groups of >= 3 count as one run.
    let run = 0;
    for (const g of groups) {
      if (g.length >= 3) {
        run += g.length;
        if (run >= MIN_PAN_DIGITS) return true;
      } else {
        run = 0;
      }
    }
  }
  return false;
}

/** Keys whose string values are machine data (ids, hashes, timestamps), not free text. */
const MACHINE_KEY = /(^id$|_id$|hash|_at$|^device_time$|^business_date$)/;
/** `*_ids` keys (Z coverage lists): UUID-format values are skipped; any other value under such a key is scanned. */
const ID_LIST_KEY = /_ids$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Staff actor fields (STAFF §7.2: `created_by`, `voided_by`, `approved_by`, `actor` …): skipped only when the value is a UUID or 'register'. */
const ACTOR_KEY = /(_by$|^actor$)/;

/** Every free-text string in a JSON value that looks like a card number, as `path` strings. */
export function findCardNumbers(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return containsCardNumber(value) ? [path || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findCardNumbers(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      if (MACHINE_KEY.test(k)) return [];
      const at = path ? `${path}.${k}` : k;
      if (ACTOR_KEY.test(k) && (v === null || (typeof v === 'string' && (UUID.test(v) || v === 'register')))) return [];
      if (ID_LIST_KEY.test(k) && Array.isArray(v)) return v.flatMap((x, i) => (typeof x === 'string' && UUID.test(x) ? [] : findCardNumbers(x, `${at}[${i}]`)));
      return findCardNumbers(v, at);
    });
  }
  return [];
}
