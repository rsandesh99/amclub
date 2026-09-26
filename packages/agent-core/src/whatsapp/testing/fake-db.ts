import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * An in-memory stand-in for the PostgREST query builder — TESTS ONLY (the send path's unit tests). Covers select /
 * insert / update / upsert with eq / neq / is / in / gte / gt / lt / lte, order, limit, maybeSingle / single, plus:
 *   - single-column unique constraints (`unique`) → 23505 on insert;
 *   - `missingTables` → PGRST205 on any access (a migration not applied yet);
 *   - `missingColumns` → PGRST204 when an insert / update names one;
 *   - `updated_at` bumped on every update (the 0086 trigger), so compare-and-set on it works;
 *   - storage.download of seeded objects.
 * Selected columns are not projected.
 */

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean
export interface FakeError { message: string; code?: string }

export interface FakeDbOptions {
  unique?: Record<string, string[]>
  missingTables?: string[]
  missingColumns?: Record<string, string[]>
  objects?: Record<string, Uint8Array>
}

export interface FakeDb {
  client: SupabaseClient
  tables: Record<string, Row[]>
  calls: Array<{ table: string; op: string }>
}

const cmp = (a: unknown, b: unknown) => (a === null || a === undefined ? NaN : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

export function fakeDb(seed: Record<string, Row[]> = {}, opts: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const calls: FakeDb['calls'] = []
  let seq = 0
  let tick = 0
  const stamp = () => new Date(Date.UTC(2026, 8, 26, 0, 0, 0) + ++tick).toISOString()

  function builder(table: string) {
    const rows = () => (tables[table] ??= [])
    const filters: Filter[] = []
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let patch: Row = {}
    let inserts: Row[] = []
    let onConflict: string | null = null
    let returning = false
    let order: { col: string; asc: boolean } | null = null
    let limit: number | null = null
    let mode: 'many' | 'maybe' | 'single' = 'many'

    const fail = (e: FakeError) => ({ data: null, error: e })
    const shape = (list: Row[]) => {
      if (mode === 'many') return { data: list.map((r) => ({ ...r })), error: null }
      if (list.length > 1) return fail({ message: 'multiple rows', code: 'PGRST116' })
      if (list.length === 0) return mode === 'single' ? fail({ message: 'no rows', code: 'PGRST116' }) : { data: null, error: null }
      return { data: { ...list[0]! }, error: null }
    }
    const missingCol = (r: Row): string | undefined => (opts.missingColumns?.[table] ?? []).find((c) => c in r)

    const run = (): { data: unknown; error: FakeError | null } => {
      calls.push({ table, op })
      if (opts.missingTables?.includes(table)) return fail({ message: `Could not find the table 'public.${table}' in the schema cache`, code: 'PGRST205' })
      if (op === 'insert' || op === 'upsert') {
        const created: Row[] = []
        for (const r of inserts) {
          const col = missingCol(r)
          if (col) return fail({ message: `Could not find the '${col}' column of '${table}' in the schema cache`, code: 'PGRST204' })
          if (op === 'upsert' && onConflict) {
            const keys = onConflict.split(',')
            const hit = rows().find((x) => keys.every((k) => x[k] === r[k]))
            if (hit) {
              Object.assign(hit, r, { updated_at: stamp() })
              created.push(hit)
              continue
            }
          }
          for (const u of opts.unique?.[table] ?? []) {
            if (r[u] !== undefined && r[u] !== null && rows().some((x) => x[u] === r[u])) return fail({ message: `duplicate key value violates unique constraint "${table}_${u}"`, code: '23505' })
          }
          const row = { id: r['id'] ?? `${table}-${++seq}`, created_at: r['created_at'] ?? stamp(), updated_at: stamp(), ...r }
          rows().push(row)
          created.push(row)
        }
        return returning ? shape(created) : { data: null, error: null }
      }
      let hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        const col = missingCol(patch)
        if (col) return fail({ message: `Could not find the '${col}' column of '${table}' in the schema cache`, code: 'PGRST204' })
        for (const r of hit) Object.assign(r, patch, { updated_at: stamp() })
        return returning ? shape(hit) : { data: null, error: null }
      }
      if (order) {
        const o = order
        hit = [...hit].sort((a, b) => (o.asc ? 1 : -1) * (cmp(a[o.col], b[o.col]) || 0))
      }
      if (limit !== null) hit = hit.slice(0, limit)
      return shape(hit)
    }

    const b = {
      select() {
        if (op !== 'select') returning = true
        return b
      },
      insert(r: Row | Row[]) {
        op = 'insert'
        inserts = Array.isArray(r) ? r : [r]
        return b
      },
      upsert(r: Row | Row[], o?: { onConflict?: string }) {
        op = 'upsert'
        inserts = Array.isArray(r) ? r : [r]
        onConflict = o?.onConflict ?? null
        return b
      },
      update(p: Row) {
        op = 'update'
        patch = p
        return b
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v)
        return b
      },
      neq(col: string, v: unknown) {
        filters.push((r) => r[col] !== v)
        return b
      },
      is(col: string, v: null) {
        filters.push((r) => (r[col] ?? null) === v)
        return b
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]))
        return b
      },
      gt(col: string, v: unknown) {
        filters.push((r) => cmp(r[col], v) > 0)
        return b
      },
      gte(col: string, v: unknown) {
        filters.push((r) => cmp(r[col], v) >= 0)
        return b
      },
      lt(col: string, v: unknown) {
        filters.push((r) => cmp(r[col], v) < 0)
        return b
      },
      lte(col: string, v: unknown) {
        filters.push((r) => cmp(r[col], v) <= 0)
        return b
      },
      order(col: string, o?: { ascending?: boolean }) {
        order = { col, asc: o?.ascending !== false }
        return b
      },
      limit(n: number) {
        limit = n
        return b
      },
      maybeSingle() {
        mode = 'maybe'
        return Promise.resolve(run())
      },
      single() {
        mode = 'single'
        return Promise.resolve(run())
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        try {
          return Promise.resolve(resolve(run()))
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e)
        }
      },
    }
    return b
  }

  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        async download(path: string) {
          const bytes = opts.objects?.[`${bucket}/${path}`]
          return bytes ? { data: new Blob([Uint8Array.from(bytes)]), error: null } : { data: null, error: { message: 'not found' } }
        },
      }),
    },
  } as unknown as SupabaseClient
  return { client, tables, calls }
}
