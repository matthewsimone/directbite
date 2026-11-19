#!/usr/bin/env node
// ============================================================================
// vendor-ordr-core.mjs — copy the Ordr POS pricing module into directbite
// ============================================================================
//
//   node scripts/vendor-ordr-core.mjs <ordr-pos path> [--commit <sha>]
//
// Copies ordr-pos src/core/money.ts + src/core/order/*.ts (non-test) into
// supabase/functions/_shared/ordr-core/ byte-for-byte, keeping the layout
// under src/core/, and rewrites VENDORED.json.
//
// Bytes are read from git objects at the commit (`git show <sha>:<path>`), not
// the working tree, so `sourceCommit` in the manifest describes exactly what
// was copied. Default commit is HEAD; without --commit the source's src/core
// must be clean, so HEAD really is what the developer is looking at.
//
// Files previously vendored but no longer in the source set are removed.
// Never hand-edit the output: fix ordr-pos and re-run this.
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANIFEST_PATH,
  SOURCE_ROOT,
  VENDOR_DIR,
  isVendoredPath,
  serializeManifest,
  sha256,
} from './lib/ordrCore.mjs';

function usage(msg) {
  if (msg) console.error(`vendor-ordr-core: ${msg}`);
  console.error('usage: node scripts/vendor-ordr-core.mjs <ordr-pos path> [--commit <sha>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let sourcePath = null;
let commitArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--commit') commitArg = args[++i] ?? usage('--commit needs a value');
  else if (!sourcePath) sourcePath = args[i];
  else usage(`unexpected argument ${args[i]}`);
}
if (!sourcePath) usage();
sourcePath = path.resolve(sourcePath);

const git = (...a) => execFileSync('git', ['-C', sourcePath, ...a], { maxBuffer: 64 * 1024 * 1024 });
const gitText = (...a) => git(...a).toString('utf8').trim();

try {
  gitText('rev-parse', '--git-dir');
} catch {
  usage(`${sourcePath} is not a git checkout`);
}

const commit = gitText('rev-parse', '--verify', `${commitArg ?? 'HEAD'}^{commit}`);
if (!commitArg && gitText('status', '--porcelain', '--', SOURCE_ROOT)) {
  usage(`${SOURCE_ROOT} has uncommitted changes in ${sourcePath}; commit them or pass --commit`);
}

let sourceRepo;
try {
  sourceRepo = gitText('remote', 'get-url', 'origin');
} catch {
  sourceRepo = path.basename(sourcePath);
}

const relPaths = gitText('ls-tree', '-r', '--name-only', commit, '--', `${SOURCE_ROOT}/`)
  .split('\n')
  .filter(Boolean)
  .map((p) => p.slice(SOURCE_ROOT.length + 1))
  .filter(isVendoredPath)
  .sort();
if (!relPaths.includes('money.ts')) usage(`${SOURCE_ROOT}/money.ts not found at ${commit}`);

// Remove files from the previous vendoring that are not in the new set.
if (fs.existsSync(MANIFEST_PATH)) {
  const old = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const rel of Object.keys(old.files ?? {})) {
    if (!relPaths.includes(rel)) fs.rmSync(path.join(VENDOR_DIR, rel), { force: true });
  }
}

const files = {};
for (const rel of relPaths) {
  const bytes = git('show', `${commit}:${SOURCE_ROOT}/${rel}`);
  const dest = path.join(VENDOR_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  files[rel] = sha256(bytes);
}

fs.writeFileSync(MANIFEST_PATH, serializeManifest({ sourceRepo, sourceCommit: commit, files }));
console.log(`vendored ${relPaths.length} files from ${sourceRepo} @ ${commit}`);
for (const rel of relPaths) console.log(`  ${files[rel]}  ${rel}`);
