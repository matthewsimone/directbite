/**
 * Minimal in-memory supabase-js for the pos-online handler tests: from(table).select / eq / in / or / order /
 * single / maybeSingle / insert / update, awaited like PostgREST ({ data, error, count }). `or(...)` is RECORDED, not
 * evaluated (feedQuery.test.ts evaluates the filter strings); eq / in filters are applied. Rows are deep-copied in and out.
 */
// deno-lint-ignore-file no-explicit-any no-this-alias
export class FakeSupabase {
  readonly tables = new Map<string, Record<string, any>[]>();
  /** Every call: [table, op, ...args]. */
  readonly calls: [string, string, ...unknown[]][] = [];
  /** Fail the next N update calls on a table. */
  failUpdates = new Map<string, number>();

  rows(table: string): Record<string, any>[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  insertRow(table: string, row: Record<string, any>): void {
    this.rows(table).push(structuredClone(row));
  }

  from(table: string) {
    const self = this;
    const filters: [string, (v: unknown) => boolean][] = [];
    let mode: 'select' | 'update' | 'insert' = 'select';
    let vals: Record<string, unknown> = {};
    const q: any = {
      select(cols: string, opts?: unknown) {
        self.calls.push([table, 'select', cols, opts]);
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push([c, (x) => x === v]);
        self.calls.push([table, 'eq', c, v]);
        return q;
      },
      in(c: string, vs: unknown[]) {
        filters.push([c, (x) => vs.includes(x)]);
        self.calls.push([table, 'in', c, vs]);
        return q;
      },
      or(f: string) {
        self.calls.push([table, 'or', f]);
        return q;
      },
      order(c: string, o: unknown) {
        self.calls.push([table, 'order', c, o]);
        return q;
      },
      insert(row: Record<string, unknown>) {
        mode = 'insert';
        self.calls.push([table, 'insert', row]);
        self.rows(table).push(structuredClone(row));
        return Promise.resolve({ error: null });
      },
      update(v: Record<string, unknown>) {
        mode = 'update';
        vals = v;
        self.calls.push([table, 'update', v]);
        return q;
      },
      single() {
        const m = self.rows(table).filter((r) => filters.every(([c, f]) => f(r[c])));
        return Promise.resolve(m.length === 1 ? { data: structuredClone(m[0]), error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } });
      },
      maybeSingle() {
        const m = self.rows(table).filter((r) => filters.every(([c, f]) => f(r[c])));
        return Promise.resolve({ data: m.length ? structuredClone(m[0]) : null, error: null });
      },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        const m = self.rows(table).filter((r) => filters.every(([c, f]) => f(r[c])));
        if (mode === 'update') {
          const left = self.failUpdates.get(table) ?? 0;
          if (left > 0) {
            self.failUpdates.set(table, left - 1);
            return Promise.resolve({ error: { message: 'transient' } }).then(res, rej);
          }
          for (const r of m) Object.assign(r, structuredClone(vals));
          return Promise.resolve({ error: null }).then(res, rej);
        }
        return Promise.resolve({ data: structuredClone(m), error: null, count: m.length }).then(res, rej);
      },
    };
    return q;
  }
}
