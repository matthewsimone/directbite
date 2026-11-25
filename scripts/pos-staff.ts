// scripts/pos-staff.ts — Ordr POS staff admin (DIRECTBITE-HANDOFF item 8; ordr-pos STAFF.md S5).
//
// Run locally by Matt with his own service credentials from the environment (never committed, never
// printed):
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… deno run --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY \
//     --allow-net scripts/pos-staff.ts <command> …
// Commands / rules: supabase/functions/_shared/pos-staff/admin.ts. PINs are typed with no echo; the PIN
// is never printed, logged or stored (only scrypt(PIN, salt) with the restaurant's pin_kdf).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { runPosStaff, USAGE } from "../supabase/functions/_shared/pos-staff/admin.ts";
import { PgStaffStore } from "../supabase/functions/_shared/pos-staff/store.ts";

const enc = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(enc.encode(s));

/** Reads a line without echoing it (raw mode). Ctrl-C cancels. */
async function readHidden(label: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) throw new Error("PIN entry needs an interactive terminal");
  write(label);
  Deno.stdin.setRaw(true);
  let s = "";
  try {
    const buf = new Uint8Array(1);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const c = buf[0];
      if (c === 13 || c === 10) break;
      if (c === 3) throw new Error("cancelled");
      if (c === 127 || c === 8) {
        s = s.slice(0, -1);
        continue;
      }
      s += String.fromCharCode(c);
    }
  } finally {
    Deno.stdin.setRaw(false);
    write("\n");
  }
  return s;
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Set ${name} in the environment (it is never printed).`);
    Deno.exit(2);
  }
  return v;
}

if (Deno.args.length === 0) {
  console.log(USAGE);
  Deno.exit(2);
}

const store = new PgStaffStore(createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } }));
const code = await runPosStaff(Deno.args, {
  store,
  now: () => Date.now(),
  io: {
    out: (line) => console.log(line),
    promptPin: readHidden,
    confirm: (q) => Promise.resolve(confirm(q)),
  },
});
Deno.exit(code);
