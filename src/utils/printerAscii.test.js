// Node-runnable assertions for printerAscii (no test runner required):
//   node src/utils/printerAscii.test.js

import { toPrinterAscii } from './printerAscii.js'

const cases = [
  { name: 'null → empty', input: null, expect: '' },
  { name: 'undefined → empty', input: undefined, expect: '' },
  { name: 'number coerced', input: 42, expect: '42' },
  { name: 'plain ASCII unchanged', input: 'Large Pie #2 (well done)', expect: 'Large Pie #2 (well done)' },
  { name: '½ → 1/2', input: '½ Pepperoni', expect: '1/2 Pepperoni' },
  { name: '¼ → 1/4', input: '¼ lb', expect: '1/4 lb' },
  { name: '¾ → 3/4', input: '¾ cup', expect: '3/4 cup' },
  { name: 'curly single quotes', input: '‘Joe’s’', expect: "'Joe's'" },
  { name: 'curly double quotes', input: '“Extra”', expect: '"Extra"' },
  { name: 'en dash', input: '10–12', expect: '10-12' },
  { name: 'em dash', input: 'Pizza—Large', expect: 'Pizza-Large' },
  { name: 'ellipsis', input: 'Wait…', expect: 'Wait...' },
  { name: 'bullet', input: '• Extra cheese', expect: '* Extra cheese' },
  { name: 'non-breaking space', input: 'No\u00A0onions', expect: 'No onions' },
  { name: 'degree', input: 'Bake 450°', expect: 'Bake 450deg' },
  { name: 'accents stripped', input: 'Jalapeño Crème Brûlée', expect: 'Jalapeno Creme Brulee' },
  { name: 'precomposed é', input: 'Café', expect: 'Cafe' },
  { name: 'decomposed e + U+0301', input: 'Cafe\u0301', expect: 'Cafe' },
  { name: 'emoji removed, spaces collapsed', input: 'Ring 🔔 bell 🍕🍕 please', expect: 'Ring bell please' },
  { name: 'ZWJ emoji sequence removed', input: 'Chef 👨\u200D🍳 special', expect: 'Chef special' },
  { name: 'newlines become spaces', input: 'Leave at door.\nTEST', expect: 'Leave at door. TEST' },
  { name: 'CJK dropped', input: 'Dumplings 饺子', expect: 'Dumplings' },
  { name: 'repeated spaces collapsed', input: 'a    b', expect: 'a b' },
]

let failures = 0
for (const c of cases) {
  const got = toPrinterAscii(c.input)
  const pass = got === c.expect && /^[\x20-\x7E]*$/.test(got)
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected "${c.expect}", got "${got}")`)
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures ? 1 : 0)
