// Node-runnable assertions for dspProvider (no test runner required):
//   node src/utils/dspProvider.test.js
// Pins providerDisplay outputs (used by the Epson DSP ticket and the provider
// banner) and providerIcon src/initials (tablet tiles + detail header).

import { providerDisplay, providerIcon, ORDR_ICON } from './dspProvider.js'

const cases = []
const eq = (name, got, expect) => cases.push({ name, got, expect })
const j = v => JSON.stringify(v)

const DD = { provider_id: 'doordash' }
const UE = { provider_id: 'ubereats' }
const GH = { provider_id: 'grubhub' }
const XX = { provider_id: 'chownow', provider_name: 'Chow Now' }

eq('display doordash', j(providerDisplay(DD)),
  j({ label: 'DOORDASH', name: 'DoorDash', cls: 'bg-red-600 text-white', border: 'border-l-red-600' }))
eq('display ubereats', j(providerDisplay(UE)),
  j({ label: 'UBER EATS', name: 'Uber Eats', cls: 'bg-black text-white', border: 'border-l-black' }))
eq('display grubhub', j(providerDisplay(GH)),
  j({ label: 'GRUBHUB', name: 'Grubhub', cls: 'bg-orange-500 text-white', border: 'border-l-orange-500' }))
eq('display unknown', j(providerDisplay(XX)),
  j({ label: 'CHOW NOW', name: 'Chow Now', cls: 'bg-gray-700 text-white', border: 'border-l-gray-700' }))
eq('display loose match (Uber_Eats)', providerDisplay({ provider_name: 'Uber_Eats' }).label, 'UBER EATS')
eq('display nothing -> DSP', providerDisplay({}).label, 'DSP')

eq('icon doordash', j(providerIcon(DD)), j({ src: '/dsp-icons/doordash.png?v=1', initials: 'D', name: 'DoorDash' }))
eq('icon ubereats', j(providerIcon(UE)), j({ src: '/dsp-icons/ubereats.png?v=1', initials: 'UE', name: 'Uber Eats' }))
eq('icon grubhub', j(providerIcon(GH)), j({ src: '/dsp-icons/grubhub.png?v=1', initials: 'G', name: 'Grubhub' }))
eq('icon unknown', j(providerIcon(XX)), j({ src: null, initials: 'CN', name: 'Chow Now' }))
eq('ORDR_ICON', ORDR_ICON, '/dsp-icons/ordr.png?v=1')

let failures = 0
for (const c of cases) {
  const pass = c.got === c.expect
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${c.got})`)
}
console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures ? 1 : 0)
