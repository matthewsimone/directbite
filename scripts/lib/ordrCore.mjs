// ============================================================================
// ordrCore.mjs — shared helpers for the vendored Ordr POS pricing module
// ============================================================================
//
// supabase/functions/_shared/ordr-core/ holds a BYTE-IDENTICAL copy of the
// Ordr POS pricing module (ordr-pos: src/core/money.ts + src/core/order/*.ts,
// non-test files), laid out exactly as under src/core/ so its relative `.ts`
// imports (`../money.ts`) resolve unchanged. VENDORED.json records where the
// bytes came from and the sha256 of every file.
//
// The vendored files are never edited here. A fix belongs in ordr-pos; then
// re-run scripts/vendor-ordr-core.mjs. Used by vendor-ordr-core.mjs and
// check-ordr-core.mjs.
// ============================================================================

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const VENDOR_DIR = path.join(REPO_ROOT, 'supabase/functions/_shared/ordr-core');
export const MANIFEST_PATH = path.join(VENDOR_DIR, 'VENDORED.json');

/** Directory inside ordr-pos that maps onto VENDOR_DIR. */
export const SOURCE_ROOT = 'src/core';

/**
 * Which source files are vendored, as paths relative to SOURCE_ROOT:
 * money.ts and every non-test .ts directly under order/.
 */
export function isVendoredPath(rel) {
  if (rel === 'money.ts') return true;
  return /^order\/[^/]+\.ts$/.test(rel) && !rel.endsWith('.test.ts');
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Stable JSON for the manifest: sorted file keys, 2-space indent, trailing newline. */
export function serializeManifest({ sourceRepo, sourceCommit, files }) {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return `${JSON.stringify({ sourceRepo, sourceCommit, files: sorted }, null, 2)}\n`;
}
