/**
 * Static inertness guard for the AMC Mart dark build.
 *
 * The staged Mart migrations (0022–0025) add columns that production does not
 * have until the Launch Gate deploy. A PostgREST select that names a missing
 * column fails the entire query — so any non-Mart server code that lists a
 * staged column in a select string silently breaks services with the flag
 * off (2026-09-09: RFQ fan-out + list + compare + quote→order). This script
 * scans every non-Mart file under apps/web/app and apps/web/lib for select
 * strings or filters that name a staged column directly. The only legal
 * place for those names is lib/mart/** (incl. lib/mart/staged-columns.ts,
 * whose fragments are empty while MART_ENABLED=false).
 *
 * Runs offline (no DB, no server). Exit 1 on any hit.
 *   pnpm --filter @amclub/web mart:static
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Keep in sync with the migrations 0022–0025 column additions on SERVICES
// tables (rfqs, quotes, orders, provider_profiles, checkout_sessions). The
// staged 0069 (E16) adds columns to Mart tables only (products,
// mart_categories), so nothing here changes for it.
const STAGED_COLUMNS = [
  'sells_goods',            // provider_profiles (0022)
  'line_items',             // orders / checkout_sessions (0022)
  'delivery_snapshot',      // orders / checkout_sessions (0022)
  'mart_category_slug',     // rfqs (0024)
  'goods_spec',             // rfqs (0024)
  'unit_price_paise',       // quotes (0024)
  'gst_rate_bps',           // quotes (0024)
  'hsn_code',               // quotes (0024)
  'product_id',             // quotes (0024)
]
// `kind` and `qty` are too generic to grep alone: `orders.kind` is LIVE (0020),
// `rfqs.kind` is STAGED (0024). Guard them by table context below.
const STAGED_BY_TABLE: Record<string, string[]> = {
  rfqs: ['kind', 'qty'],
  quotes: ['qty'],
}

const ROOT = join(__dirname, '..')
const SCAN = ['app', 'lib'].map((d) => join(ROOT, d))
const isMartPath = (p: string) => {
  const rel = relative(ROOT, p).split(sep).join('/')
  return rel.includes('/mart/') || rel.includes('(mart-') || rel.startsWith('lib/mart/')
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

// Every string literal passed to .select(...) or used as a column in .eq/.is/.in/.order(...)
const SELECT_RE = /\.select\(\s*(['"`])([\s\S]*?)\1/g
const FILTER_RE = /\.(eq|neq|is|in|order|gt|gte|lt|lte|like|ilike|not)\(\s*(['"`])([^'"`]+)\2/g

const hits: string[] = []
for (const base of SCAN) {
  for (const file of walk(base)) {
    if (isMartPath(file)) continue
    const src = readFileSync(file, 'utf8')
    const lineOf = (idx: number) => src.slice(0, idx).split('\n').length
    const check = (text: string, idx: number, what: string) => {
      for (const col of STAGED_COLUMNS) {
        if (new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`).test(text)) {
          hits.push(`${relative(ROOT, file)}:${lineOf(idx)}  ${what} names staged column '${col}'`)
        }
      }
      for (const [table, cols] of Object.entries(STAGED_BY_TABLE)) {
        // Only flag when the same select/filter text mentions the table (join
        // alias like `rfq:rfqs!inner(` or `from('rfqs')` within 300 chars before).
        const before = src.slice(Math.max(0, idx - 300), idx)
        const tableInScope = text.includes(`${table}!inner(`) || text.includes(`${table}(`) || before.includes(`from('${table}')`)
        if (!tableInScope) continue
        for (const col of cols) {
          if (new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`).test(text)) {
            hits.push(`${relative(ROOT, file)}:${lineOf(idx)}  ${what} on ${table} names staged column '${col}'`)
          }
        }
      }
    }
    for (const m of src.matchAll(SELECT_RE)) check(m[2]!, m.index!, 'select()')
    for (const m of src.matchAll(FILTER_RE)) check(m[3]!, m.index!, `${m[1]}()`)
  }
}

if (hits.length) {
  console.error('✗ Mart static inertness: staged columns named outside lib/mart/**:\n  ' + hits.join('\n  '))
  console.error('\n  Use the fragments in lib/mart/staged-columns.ts (empty while MART_ENABLED=false).')
  process.exit(1)
}
console.log('✓ Mart static inertness: no non-Mart select/filter names a staged column.')
