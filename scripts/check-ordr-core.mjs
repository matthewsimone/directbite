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
// Also: _shared/pos-v1/ordrCoreInfo.generated.ts equals what the manifest
// renders to (PRICING_MODULE_HASH + SOURCE_COMMIT).
//
// With --source: also byte-compares each vendored file with the ordr-pos
// working tree (src/core/<path>), and fails if the source's vendorable set
// (money.ts + order/*.ts, non-test) has files the manifest does not. Any diff
// means re-vendor (scripts/vendor-ordr-core.mjs), never edit the copy.
//
// Also (items 4, 7): _shared/ordr-core-ext/ — availability.ts + cardData.ts + drawer.ts (+ the pinned
// money.ts re-export shim drawer.ts imports), with
// their own VENDORED.json — gets the same checks (bytes = manifest, nothing
// else in the directory, and with --source byte-equal to ordr-pos src/core).
// They are NOT part of pricingModuleHash (only ordr-core/'s manifest is).
//
// Also (CP19): the admin-refund handler glue copied into _shared/pos-online/adminRefundGlue.ts — the web source
// range is pinned by hash (_shared/pos-online/adminRefundPin.json); any change to those lines fails.
//
// Exit 0 = clean, 1 = drift (every problem listed), 2 = usage / bad manifest.
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXT_FILES, EXT_MANIFEST_PATH, EXT_SHIMS, EXT_VENDOR_DIR, MANIFEST_PATH, MODULE_INFO_PATH, SOURCE_ROOT, VENDOR_DIR, isVendoredPath, renderModuleInfo, sha256 } from './lib/ordrCore.mjs';

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

// 3. The generated identity constants match the manifest (byte-exact).
const expectedInfo = renderModuleInfo(manifest);
if (!fs.existsSync(MODULE_INFO_PATH)) {
  problems.push(`missing generated file: ${path.relative(process.cwd(), MODULE_INFO_PATH)}`);
} else if (fs.readFileSync(MODULE_INFO_PATH, 'utf8') !== expectedInfo) {
  problems.push(`${path.relative(process.cwd(), MODULE_INFO_PATH)} does not match VENDORED.json (re-run vendor-ordr-core.mjs; never hand-edit)`);
}

// 4. Optional: byte-compare against an ordr-pos checkout.
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

// 5. ordr-core-ext (item 4): non-pricing vendored files, own manifest.
let ext = null;
try {
  ext = JSON.parse(fs.readFileSync(EXT_MANIFEST_PATH, 'utf8'));
} catch (err) {
  problems.push(`cannot read ${path.relative(process.cwd(), EXT_MANIFEST_PATH)}: ${err.message}`);
}
if (ext) {
  const extFiles = ext.files ?? {};
  for (const name of EXT_FILES) if (!(name in extFiles)) problems.push(`ordr-core-ext manifest lacks ${name}`);
  for (const rel of Object.keys(extFiles).sort()) {
    const file = path.join(EXT_VENDOR_DIR, rel);
    if (!fs.existsSync(file)) { problems.push(`missing vendored file: ordr-core-ext/${rel}`); continue; }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== extFiles[rel]) problems.push(`hash mismatch: ordr-core-ext/${rel}\n    manifest ${extFiles[rel]}\n    on disk  ${actual}`);
    if (sourcePath) {
      const src = path.join(sourcePath, SOURCE_ROOT, rel);
      if (!fs.existsSync(src)) problems.push(`source no longer has: ${SOURCE_ROOT}/${rel}`);
      else if (!fs.readFileSync(src).equals(fs.readFileSync(file))) {
        problems.push(`differs from source: ordr-core-ext/${rel}\n    vendored ${actual}\n    source   ${sha256(fs.readFileSync(src))}`);
      }
    }
  }
  // local shims: exactly the pinned text, listed in the manifest's "shims"
  for (const [rel, text] of Object.entries(EXT_SHIMS)) {
    const file = path.join(EXT_VENDOR_DIR, rel);
    if ((ext.shims ?? {})[rel] !== text) problems.push(`ordr-core-ext manifest shim ${rel} is not the pinned text`);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) problems.push(`ordr-core-ext/${rel} is not exactly the pinned shim`);
  }
  for (const rel of walk(EXT_VENDOR_DIR)) {
    if (rel !== 'VENDORED.json' && !(rel in extFiles) && !(rel in EXT_SHIMS)) problems.push(`unexpected file in ordr-core-ext/ (not vendored): ${rel}`);
  }
}

// CP19: the admin-refund glue copied into _shared/pos-online (adminRefundGlue.ts) — its web source range is pinned
// by hash (adminRefundPin.json). A change to those admin-refund lines fails here: re-copy, re-review, re-pin.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PIN_PATH = path.join(REPO_ROOT, 'supabase/functions/_shared/pos-online/adminRefundPin.json');
let adminRefundPin = null;
try {
  adminRefundPin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
} catch (err) {
  problems.push(`cannot read ${path.relative(process.cwd(), PIN_PATH)}: ${err.message}`);
}
if (adminRefundPin) {
  const [from, to] = adminRefundPin.lines ?? [];
  const src = path.join(REPO_ROOT, adminRefundPin.source ?? '');
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) problems.push('adminRefundPin.json: lines must be [from, to]');
  else if (!fs.existsSync(src)) problems.push(`admin-refund pin: missing ${adminRefundPin.source}`);
  else {
    const range = fs.readFileSync(src, 'utf8').split('\n').slice(from - 1, to).join('\n') + '\n';
    const actual = sha256(Buffer.from(range, 'utf8'));
    if (actual !== adminRefundPin.sha256) {
      problems.push(`admin-refund changed: ${adminRefundPin.source}:${from}-${to}\n    pinned  ${adminRefundPin.sha256}\n    on disk ${actual}\n    re-copy into ${adminRefundPin.copy}, re-review, then re-pin`);
    }
  }
  const copy = path.join(REPO_ROOT, adminRefundPin.copy ?? '');
  if (!fs.existsSync(copy)) problems.push(`admin-refund pin: missing copy ${adminRefundPin.copy}`);
  else if (!fs.readFileSync(copy, 'utf8').includes(adminRefundPin.sha256)) problems.push(`${adminRefundPin.copy} does not cite the pinned hash (re-pin both together)`);
}

if (problems.length) {
  console.error(`check-ordr-core: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Never edit vendored files. Fix ordr-pos, then: node scripts/vendor-ordr-core.mjs <ordr-pos path>');
  process.exit(1);
}
console.log(`check-ordr-core: OK — ${manifestPaths.length} files match ${sourceRepo} @ ${sourceCommit.slice(0, 7)}${sourcePath ? ' and the source checkout' : ''}; ordr-core-ext ${Object.keys(ext?.files ?? {}).length} files @ ${String(ext?.sourceCommit ?? '').slice(0, 7)}; admin-refund pin ${adminRefundPin.source}:${adminRefundPin.lines.join('-')} @ ${adminRefundPin.sha256.slice(0, 12)}`);
