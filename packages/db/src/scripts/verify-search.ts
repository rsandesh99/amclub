/** Verify the search_packages RPC against seed data: per-category counts,
 * a text query, a filter, and timing. Run: tsx src/scripts/verify-search.ts */
import postgres from 'postgres'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const sql = postgres(process.env['DATABASE_URL']!, { max: 1 })

const CATS = [
  'company-registrations', 'tax-accounting', 'legal', 'hr-staffing',
  'finance-facilitation', 'digital-marketing', 'web-tech', 'government-licensing',
]

async function main() {
  // Total
  const all = await sql`SELECT * FROM search_packages(p_limit => 100)`
  console.log(`\nTotal active results: ${all.length} (total_count=${all[0]?.['total_count'] ?? 0})`)

  // Per category
  console.log('\nPer-category counts:')
  for (const c of CATS) {
    const rows = await sql`SELECT total_count FROM search_packages(p_category_slug => ${c}, p_limit => 1)`
    console.log(`  ${c.padEnd(24)} = ${rows[0]?.['total_count'] ?? 0}`)
  }

  // Text query
  const q = await sql`SELECT package_id, title_i18n FROM search_packages(p_query => 'GST', p_limit => 50)`
  console.log(`\nFTS query "GST" → ${q.length} results`)

  // Filter: verified-only + rating
  const f = await sql`SELECT total_count FROM search_packages(p_verified_only => true, p_min_rating => 4.0, p_limit => 1)`
  console.log(`Verified-only + rating>=4.0 → ${f[0]?.['total_count'] ?? 0} results`)

  // Sort price_asc sanity
  const s = await sql`SELECT price_paise FROM search_packages(p_sort => 'price_asc', p_limit => 3)`
  console.log(`Cheapest 3 (paise): ${s.map((r) => r['price_paise']).join(', ')}`)

  // Timing — 20 runs, p95
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await sql`SELECT * FROM search_packages(p_category_slug => 'tax-accounting', p_sort => 'rating', p_limit => 24)`
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.floor(times.length * 0.95)]!
  const median = times[Math.floor(times.length / 2)]!
  console.log(`\nTiming over 20 runs: median=${median.toFixed(1)}ms  p95=${p95.toFixed(1)}ms`)

  await sql.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
