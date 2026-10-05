// Epson TM-series printers render printable ASCII reliably; anything else
// (curly quotes from DSP menus, accented names, emoji in notes) prints as
// garbage or '?'. Map the common cases to readable ASCII, strip accents, and
// drop whatever is left. Apply to VALUES before composing padded lines — the
// space-collapse would otherwise eat intentional indentation.

const REPLACEMENTS = [
  [/\u00BD/g, '1/2'],                       // ½
  [/\u00BC/g, '1/4'],                       // ¼
  [/\u00BE/g, '3/4'],                       // ¾
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"], // curly single quotes, prime
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'], // curly double quotes, double prime
  [/[\u2013\u2014]/g, '-'],                 // – —
  [/\u2026/g, '...'],                       // …
  [/\u2022/g, '*'],                         // •
  [/\u00A0/g, ' '],                         // non-breaking space
  [/\u00B0/g, 'deg'],                       // °
  [/[\r\n\t]+/g, ' '],                      // line breaks in notes → one line
]

export function toPrinterAscii(str) {
  if (str == null) return ''
  let s = String(str)
  for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep)
  s = s.normalize('NFKD').replace(/[\u0300-\u036F]/g, '')
  s = s.replace(/[^\x20-\x7E]/g, '')
  return s.replace(/ {2,}/g, ' ').trim()
}
