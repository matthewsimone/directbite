// Node-runnable assertions for khProviderStatus (no test runner required):
//   node supabase/functions/_shared/khProviderStatus.test.mjs

import { providerStatusStoreIds, toProviderStatusPatch } from './khProviderStatus.ts';

const cases = [];
const eq = (name, got, expect) => cases.push({ name, got, expect });
const NOW = Date.parse('2026-10-05T20:00:00Z');

eq('ids: restaurant + proxy', JSON.stringify(providerStatusStoreIds({ restaurant_data: { restaurant_id: 'a', proxy_restaurant_id: 'b' } })), '["a","b"]');
eq('ids: dedupe', JSON.stringify(providerStatusStoreIds({ restaurant_data: { restaurant_id: 'a', proxy_restaurant_id: 'a' } })), '["a"]');
eq('ids: none', JSON.stringify(providerStatusStoreIds({})), '[]');

const acct = (cs, comment) => ({ integration_account_data: { provider_id: 'doordash', account_id: 'x', connection_status: cs, connection_status_comment: comment } });
eq('acct: disabled', toProviderStatusPatch('IntegrationAccount', acct('disabled', 'Menu sync failed'), NOW).fields.connection_status, 'disabled');
eq('acct: reason', toProviderStatusPatch('IntegrationAccount', acct('disabled', 'Menu sync failed'), NOW).fields.reason, 'Menu sync failed');
eq('acct: no online fields', 'online_status' in toProviderStatusPatch('IntegrationAccount', acct('connected'), NOW).fields, false);
eq('acct: missing provider -> null', toProviderStatusPatch('IntegrationAccount', { integration_account_data: {} }, NOW), null);

const os = (status, reason, secs) => ({ online_status_data: { provider_id: 'ubereats', account_id: 'y', online_status: status, offline_reason: reason, pause_duration_seconds: secs } });
eq('online: clears reason', toProviderStatusPatch('IntegrationAccountOnlineStatus', os('online', 'x', 60), NOW).fields.reason, null);
eq('online: clears pause', toProviderStatusPatch('IntegrationAccountOnlineStatus', os('online', 'x', 60), NOW).fields.pause_until, null);
eq('offline: pause_until', toProviderStatusPatch('IntegrationAccountOnlineStatus', os('offline', 'busy', 1800), NOW).fields.pause_until, '2026-10-05T20:30:00.000Z');
eq('offline: no duration -> null', toProviderStatusPatch('IntegrationAccountOnlineStatus', os('offline', 'busy'), NOW).fields.pause_until, null);
eq('offline: garbage duration -> null', toProviderStatusPatch('IntegrationAccountOnlineStatus', os('offline', 'busy', 'abc'), NOW).fields.pause_until, null);
eq('offline: no connection field', 'connection_status' in toProviderStatusPatch('IntegrationAccountOnlineStatus', os('offline'), NOW).fields, false);
eq('unknown type -> null', toProviderStatusPatch('Delivery', os('offline'), NOW), null);

let failures = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(c.got)})`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
