#!/usr/bin/env node
// ============================================================================
// check-ordr-core.mjs — drift guard for the vendored Ordr POS pricing module
// ============================================================================
//
//   node scripts/check-ordr-core.mjs                      (npm run check:ordr-core)
//   node scripts/check-ordr-core.mjs --source <ordr-pos path>
//
// Always: every file in VENDORED.json exists under _shared/ordr-core/ with
// the recorded sha256, and nothing else lives in that directory. Catches a
// hand edit of a vendored file, or a non-vendored file placed beside them.
//
// With --source: also byte-compares each vendored file with the ordr-pos
// working tree (src/core/<path>), and fails if the source's vendorable set
// (money.ts + order/*.ts, non-test) has files the manifest does not. Any diff
// means re-vendor (scripts/vendor-ordr-core.mjs), never edit the copy.
//
// Exit 0 = clean, 1 = drift (every problem listed), 2 = usage / bad manifest.
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_PATH, SOURCE_ROOT, VENDOR_DIR, isVendoredPath, sha256 } from './lib/ordrCore.mjs';

const args = process.argv.slice(2);
let sourcePath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source' && args[i + 1]) sourcePath = path.resolve(args[++i]);
  else {
    console.error('usage: node scripts/check-ordr-core.mjs [--source <ordr-pos path>]');
    process.exit(2);
  }
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  console.error(`check-ordr-core: cannot read ${path.relative(process.cwd(), MANIFEST_PATH)}: ${err.message}`);
  process.exit(2);
}
const { sourceRepo, sourceCommit, files } = manifest;
if (typeof sourceRepo !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit ?? '') || !files || typeof files !== 'object') {
  console.error('check-ordr-core: VENDORED.json must be { sourceRepo, sourceCommit (40-hex), files: { path: sha256 } }');
  process.exit(2);
}

const problems = [];
const manifestPaths = Object.keys(files).sort();

// 1. Vendored bytes match the manifest.
for (const rel of manifestPaths) {
  const file = path.join(VENDOR_DIR, rel);
  if (!fs.existsSync(file)) {
    problems.push(`missing vendored file: ${rel}`);
    continue;
  }
  const actual = sha256(fs.readFileSync(file));
  if (actual !== files[rel]) problems.push(`hash mismatch: ${rel}\n    manifest ${files[rel]}\n    on disk  ${actual}`);
}

// 2. Nothing else in the vendored directory.
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
  });
}
for (const rel of walk(VENDOR_DIR)) {
  if (rel !== 'VENDORED.json' && !(rel in files)) problems.push(`unexpected file in ordr-core/ (not vendored): ${rel}`);
}

// 3. Optional: byte-compare against an ordr-pos checkout.
if (sourcePath) {
  const srcRoot = path.join(sourcePath, SOURCE_ROOT);
  if (!fs.existsSync(srcRoot)) {
    console.error(`check-ordr-core: ${srcRoot} does not exist`);
    process.exit(2);
  }
  for (const rel of manifestPaths) {
    const src = path.join(srcRoot, rel);
    const vendored = path.join(VENDOR_DIR, rel);
    if (!fs.existsSync(src)) problems.push(`source no longer has: ${SOURCE_ROOT}/${rel}`);
    else if (fs.existsSync(vendored)) {
      const srcBytes = fs.readFileSync(src);
      const vendoredBytes = fs.readFileSync(vendored);
      if (!srcBytes.equals(vendoredBytes)) {
        problems.push(`differs from source: ${rel}\n    vendored ${sha256(vendoredBytes)}\n    source   ${sha256(srcBytes)}`);
      }
    }
  }
  for (const rel of walk(srcRoot).filter(isVendoredPath)) {
    if (!(rel in files)) problems.push(`source has a file not vendored: ${SOURCE_ROOT}/${rel}`);
  }
  let head = 'unknown';
  try {
    head = execFileSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD']).toString().trim();
  } catch { /* not a git checkout: byte comparison above still applies */ }
  console.log(`source ${sourcePath} HEAD ${head}${head === sourceCommit ? '' : ` (manifest sourceCommit ${sourceCommit})`}`);
}

if (problems.length) {
  console.error(`check-ordr-core: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Never edit vendored files. Fix ordr-pos, then: node scripts/vendor-ordr-core.mjs <ordr-pos path>');
  process.exit(1);
}
console.log(`check-ordr-core: OK — ${manifestPaths.length} files match ${sourceRepo} @ ${sourceCommit.slice(0, 7)}${sourcePath ? ' and the source checkout' : ''}`);
