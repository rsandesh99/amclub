import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * An in-memory stand-in for the PostgREST query builder — TESTS ONLY. It covers
 * the subset the runtime's WhatsApp paths use (select / insert / update with
 * eq / neq / is / in / gt / gte / lt / lte, `col->>key` JSON paths, order,
 * limit, maybeSingle / single, count head) so the binding, confirmation and
 * sweep rules run without a database. Selected columns are not projected.
 */

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

function valueAt(r: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col)
  if (m) {
    const obj = r[m[1]!] as Record<string, unknown> | null | undefined
    const v = obj ? obj[m[2]!] : undefined
    return v === undefined || v === null ? null : String(v)
  }
  return r[col]
}

const cmp = (a: unknown, b: unknown) => (a === null || a === undefined ? NaN : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

export interface FakeDb {
  client: SupabaseClient
  tables: Record<string, Row[]>
  uploads: Array<{ bucket: string; path: string; bytes: number }>
}

export function fakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const uploads: FakeDb['uploads'] = []
  let seq = 0

  function builder(table: string) {
    const rows = () => (tables[table] ??= [])
    const filters: Filter[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let patch: Row | null = null
    let inserts: Row[] = []
    let returning = false
    let head = false
    let wantCount = false
    let order: { col: string; asc: boolean } | null = null
    let limit: number | null = null
    let mode: 'many' | 'maybe' | 'single' = 'many'

    const run = (): { data: unknown; error: { message: string; code?: string } | null; count?: number | null } => {
      if (op === 'insert') {
        const created = inserts.map((r) => ({ id: r['id'] ?? `row-${++seq}`, created_at: r['created_at'] ?? new Date().toISOString(), ...r }))
        rows().push(...created)
        return shape(created)
      }
      let hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of hit) Object.assign(r, patch)
        return returning ? shape(hit) : { data: null, error: null }
      }
      if (op === 'delete') {
        tables[table] = rows().filter((r) => !hit.includes(r))
        return returning ? shape(hit) : { data: null, error: null }
      }
      if (order) {
        const o = order
        hit = [...hit].sort((a, b) => (o.asc ? 1 : -1) * (cmp(valueAt(a, o.col), valueAt(b, o.col)) || 0))
      }
      const count = hit.length
      if (limit !== null) hit = hit.slice(0, limit)
      if (head) return { data: null, error: null, count: wantCount ? count : null }
      return { ...shape(hit), ...(wantCount ? { count } : {}) }
    }
    const shape = (list: Row[]) => {
      if (mode === 'many') return { data: list.map((r) => ({ ...r })), error: null }
      if (list.length > 1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } }
      if (list.length === 0) return mode === 'single' ? { data: null, error: { message: 'no rows', code: 'PGRST116' } } : { data: null, error: null }
      return { data: { ...list[0]! }, error: null }
    }

    const b = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op !== 'select') returning = true
        if (opts?.head) head = true
        if (opts?.count) wantCount = true
        return b
      },
      insert(r: Row | Row[]) {
        op = 'insert'
        inserts = Array.isArray(r) ? r : [r]
        return b
      },
      update(p: Row) {
        op = 'update'
        patch = p
        return b
      },
      delete() {
        op = 'delete'
        return b
      },
      eq(col: string, v: unknown) {
        filters.push((r) => valueAt(r, col) === v)
        return b
      },
      neq(col: string, v: unknown) {
        filters.push((r) => valueAt(r, col) !== v)
        return b
      },
      is(col: string, v: null) {
        filters.push((r) => (valueAt(r, col) ?? null) === v)
        return b
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(valueAt(r, col)))
        return b
      },
      gt(col: string, v: unknown) {
        filters.push((r) => cmp(valueAt(r, col), v) > 0)
        return b
      },
      gte(col: string, v: unknown) {
        filters.push((r) => cmp(valueAt(r, col), v) >= 0)
        return b
      },
      lt(col: string, v: unknown) {
        filters.push((r) => cmp(valueAt(r, col), v) < 0)
        return b
      },
      lte(col: string, v: unknown) {
        filters.push((r) => cmp(valueAt(r, col), v) <= 0)
        return b
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order = { col, asc: opts?.ascending !== false }
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
        async upload(path: string, bytes: Uint8Array) {
          uploads.push({ bucket, path, bytes: bytes.byteLength })
          return { data: { path }, error: null }
        },
      }),
    },
  } as unknown as SupabaseClient
  return { client, tables, uploads }
}
