// Node-runnable assertions for dspProviderStatus (no test runner required):
//   node src/utils/dspProviderStatus.test.js

import { providerSeverity, providerBannerText } from './dspProviderStatus.js'

const cases = []
const eq = (name, got, expect) => cases.push({ name, got, expect })
const off = (reason, extra = {}) => ({ provider_id: 'ubereats', online_status: 'offline', reason, ...extra })

eq('null row ok', providerSeverity(null), 'ok')
eq('online ok', providerSeverity({ online_status: 'online' }), 'ok')
eq('no data ok', providerSeverity({}), 'ok')
eq('connected + online ok', providerSeverity({ connection_status: 'connected', online_status: 'online' }), 'ok')
eq('disabled critical', providerSeverity({ connection_status: 'disabled', online_status: 'online' }), 'critical')
eq('rejected critical', providerSeverity({ connection_status: 'REJECTED' }), 'critical')
eq('in_progress info', providerSeverity({ connection_status: 'in_progress' }), 'info')
eq('waiting info', providerSeverity({ connection_status: 'waiting' }), 'info')
eq('waiting_menu info', providerSeverity({ connection_status: 'waiting_menu' }), 'info')
eq('connecting beats offline', providerSeverity({ connection_status: 'waiting', online_status: 'offline' }), 'info')
eq('offline no reason critical', providerSeverity(off(null)), 'critical')
eq('offline expired critical', providerSeverity(off('Too many expired orders')), 'critical')
eq('offline cancelled critical', providerSeverity(off('Orders cancelled')), 'critical')
eq('offline deactivated critical', providerSeverity(off('Store deactivated')), 'critical')
eq('offline failed critical', providerSeverity(off('Menu sync FAILED')), 'critical')
eq('paused by system critical (system wins)', providerSeverity(off('Paused by system')), 'critical')
eq('paused by merchant info', providerSeverity(off('Paused by merchant')), 'info')
eq('manual info', providerSeverity(off('Manual pause')), 'info')
eq('busy info', providerSeverity(off('Kitchen busy')), 'info')
eq('unknown reason critical', providerSeverity(off('xyz123')), 'critical')
eq('KH PAUSED_BY_RESTAURANT info', providerSeverity(off('PAUSED_BY_RESTAURANT')), 'info')
eq('KH Store is closed info', providerSeverity(off('Store is closed')), 'info')
eq('KH Manually stopped taking orders info', providerSeverity(off('Manually stopped taking orders at 2:31 PM')), 'info')
eq('KH system pause after expired orders critical',
  providerSeverity(off('The system paused the provider for 24 hours after 2 orders were expired')), 'critical')
eq('text disconnected', providerBannerText({ provider_id: 'doordash', connection_status: 'disabled' }),
  'DOORDASH DISCONNECTED — orders are not coming in. Contact Ordr support.')
eq('text connecting in_progress', providerBannerText({ provider_id: 'grubhub', connection_status: 'in_progress' }),
  'GRUBHUB CONNECTING — setup in progress.')
eq('text connecting waiting', providerBannerText({ provider_id: 'doordash', connection_status: 'waiting' }),
  'DOORDASH CONNECTING — setup in progress.')
eq('text connecting waiting_menu', providerBannerText({ provider_id: 'ubereats', connection_status: 'waiting_menu' }),
  'UBER EATS CONNECTING — setup in progress.')
eq('text expired pause hides until', providerBannerText(off('busy', { pause_until: '2000-01-01T00:00:00Z' })), 'UBER EATS OFFLINE: busy')
eq('text critical no pause', providerBannerText(off(null)), 'UBER EATS OFFLINE — orders are not coming in.')

let failures = 0
for (const c of cases) {
  const pass = c.got === c.expect
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(c.got)})`)
}
console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures ? 1 : 0)
