// Node-runnable assertions for khAdmin (no test runner required):
//   node supabase/functions/_shared/khAdmin.test.mjs

import { parseUsAddress, safeKhBody } from './khAdmin.ts';

const cases = [];
const eq = (name, got, expect) => cases.push({ name, got, expect });
const j = (v) => JSON.stringify(v);

eq('standard', j(parseUsAddress('350 Ramapo Valley Rd, Oakland, NJ 07436')),
  j({ street: '350 Ramapo Valley Rd', city: 'Oakland', state: 'NJ', zipcode: '07436' }));
eq('strips USA', parseUsAddress('1 Main St, Mahwah, NJ 07430, USA')?.zipcode, '07430');
eq('strips United States', parseUsAddress('1 Main St, Mahwah, NJ 07430, United States')?.city, 'Mahwah');
eq('zip+4 -> 5', parseUsAddress('1 Main St, Mahwah, NJ 07430-1234')?.zipcode, '07430');
eq('suite kept in street', parseUsAddress('100 Main St, Suite 2, Mahwah, NJ 07430')?.street, '100 Main St, Suite 2');
eq('lowercase state upcased', parseUsAddress('1 Main St, Mahwah, nj 07430')?.state, 'NJ');
eq('no zip -> null', parseUsAddress('1 Main St, Mahwah, NJ'), null);
eq('two parts -> null', parseUsAddress('Mahwah, NJ 07430'), null);
eq('null -> null', parseUsAddress(null), null);
eq('safeKhBody json', j(safeKhBody('{"detail":"x"}')), '{"detail":"x"}');
eq('safeKhBody text', safeKhBody('Bad Gateway'), 'Bad Gateway');
eq('safeKhBody empty', safeKhBody(''), null);

let failures = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${j(c.expect)}, got ${j(c.got)})`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
