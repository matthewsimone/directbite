/**
 * Tests only: an in-memory PostgREST for pos-reports' reads — from(table).select(cols).eq / gte / lte / lt / in / or /
 * order / range / maybeSingle, awaited like supabase-js ({ data, error }). Projection is applied (`a,b`, `alias:col->key`;
 * `*` or an embedded resource `x(...)` returns the whole row) so a test can assert which columns were read. `or(...)` is
 * RECORDED, not evaluated (feedQuery.test.ts evaluates the history filter). Rows are deep-copied out.
 */
// deno-lint-ignore-file no-explicit-any no-this-alias
export class FakeDb {
  readonly tables = new Map<string, Record<string, any>[]>();
  /** Every select: [table, columns]. */
  readonly selects: [string, string][] = [];
  readonly ors: [string, string][] = [];
  users = new Map<string, { email: string }>();
  failTable: string | null = null;

  rows(t: string): Record<string, any>[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }

  add(t: string, ...rows: Record<string, any>[]): this {
    for (const r of rows) this.rows(t).push(structuredClone(r));
    return this;
  }

  readonly auth = {
    getUser: (token: string) => {
      const u = this.users.get(token);
      return Promise.resolve(u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } });
    },
  };

  from(table: string) {
    const self = this;
    const preds: ((r: Record<string, any>) => boolean)[] = [];
    let cols = '*';
    let key: string | null = null;
    let lo = 0;
    let hi = Number.MAX_SAFE_INTEGER;
    let single = false;
    const project = (r: Record<string, any>) => {
      if (cols.includes('*') || cols.includes('(')) return structuredClone(r);
      const out: Record<string, any> = {};
      for (const c of cols.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^(?:(\w+):)?(\w+)(?:->(\w+))?$/.exec(c);
        if (!m) throw new Error(`fake: bad column ${c}`);
        const [, alias, col, sub] = m;
        const v = sub ? (r[col] && typeof r[col] === 'object' ? r[col][sub] ?? null : null) : r[col];
        out[alias ?? col] = v === undefined ? null : structuredClone(v);
      }
      return out;
    };
    const run = () => {
      if (self.failTable === table) return { data: null, error: { message: `${table} is down` } };
      let rs = self.rows(table).filter((r) => preds.every((p) => p(r)));
      if (key) rs = [...rs].sort((a, b) => (String(a[key!]) < String(b[key!]) ? -1 : String(a[key!]) > String(b[key!]) ? 1 : 0));
      rs = rs.slice(lo, hi + 1);
      if (single) return { data: rs.length ? project(rs[0]) : null, error: null };
      return { data: rs.map(project), error: null };
    };
    const q: any = {
      select(c: string) { cols = c; self.selects.push([table, c]); return q; },
      eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return q; },
      gte(c: string, v: any) { preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] >= v); return q; },
      lte(c: string, v: any) { preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] <= v); return q; },
      lt(c: string, v: any) { preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v); return q; },
      in(c: string, vs: unknown[]) { preds.push((r) => vs.includes(r[c])); return q; },
      or(f: string) { self.ors.push([table, f]); return q; },
      order(c: string) { key = c; return q; },
      range(a: number, b: number) { lo = a; hi = b; return q; },
      maybeSingle() { single = true; return q; },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }
}
