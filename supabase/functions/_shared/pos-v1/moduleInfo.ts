/**
 * Identity of the vendored pricing module, returned with every quote so the
 * POS can check at runtime that it runs the same module as the server.
 *
 * pricingModuleHash = sha256 (hex) of the manifest's file list in
 * `sha256sum` format, sorted by path:
 *
 *     "<sha256>  <path>\n" for each file in VENDORED.json, path ascending
 *
 * i.e. what `cd src/core && sha256sum money.ts order/{errors,index,price,toppings,types}.ts`
 * prints in ordr-pos. Any byte change to any vendored file changes it.
 */
import manifest from '../ordr-core/VENDORED.json' with { type: 'json' };

export const SOURCE_COMMIT: string = manifest.sourceCommit;

export function manifestDigestInput(files: Record<string, string>): string {
  return Object.keys(files)
    .sort()
    .map((path) => `${files[path]}  ${path}\n`)
    .join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

let cached: Promise<string> | null = null;

export function pricingModuleHash(): Promise<string> {
  cached ??= sha256Hex(manifestDigestInput(manifest.files as Record<string, string>));
  return cached;
}
