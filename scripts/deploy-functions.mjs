#!/usr/bin/env node
// ============================================================================
// deploy-functions.mjs — guarded `supabase functions deploy`
// ============================================================================
//
//   npm run deploy:functions -- <function> [<function> ...] [-- <supabase flags>]
//
// 1. Runs the ordr-core drift check (scripts/check-ordr-core.mjs). Any drift
//    in the vendored pricing module aborts the deploy.
// 2. Deploys ONLY the named functions. A bare `supabase functions deploy`
//    redeploys every function in the project; that is refused here on purpose.
//
// The linked Supabase project is production: an edge-function deploy reaches
// every restaurant at once. Per-restaurant rollout (Test Pizza first) is done
// with in-function gating, not by this script.
// ============================================================================

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './lib/ordrCore.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const names = sep === -1 ? argv : argv.slice(0, sep);
const extra = sep === -1 ? [] : argv.slice(sep + 1);

if (names.length === 0 || names.some((n) => !/^[a-z0-9][a-z0-9-]*$/.test(n))) {
  console.error('usage: npm run deploy:functions -- <function> [<function> ...] [-- <supabase flags>]');
  console.error('Refusing to deploy without explicit function names (a bare deploy redeploys all functions).');
  process.exit(2);
}

const run = (cmd, args) => spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1;

if (run(process.execPath, [path.join(REPO_ROOT, 'scripts/check-ordr-core.mjs')]) !== 0) {
  console.error('deploy-functions: ordr-core drift check failed; not deploying.');
  process.exit(1);
}

console.log(`deploy-functions: deploying ${names.join(', ')}`);
process.exit(run('supabase', ['functions', 'deploy', ...names, ...extra]));
