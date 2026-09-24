/**
 * E15 FR-15.3 (F5) — the search golden set.
 *
 *   pnpm --filter @amclub/web eval:search [--set evals/search/golden.jsonl] [--min 0.85] [--k 3]
 *
 * Each line: { id, query, filters?, expect: { category_slug?, service_slug?, package_slugs? } }.
 * The query runs through the SAME anon RPC the catalog uses (search_packages_v2,
 * sort "best"); a case passes when one of the top k results matches every
 * expectation it states (category, else service, else one of the packages).
 * Reports hit@k overall and per expected category; exits 1 below --min.
 *
 * The shipped set (200 cases: 40 level-2 services × 5 phrasings, expected
 * category + service) measures the seeded catalogue. After launch, rebuild it
 * from F5's sampled real queries (search_queries) with their clicked results.
 * Read-only; needs NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const setPath = path.resolve(__dirname, '..', arg('set') ?? 'evals/search/golden.jsonl')
const min = Number(arg('min') ?? 0.85)
const k = Number(arg('k') ?? 3)
type Case = { id: string; query: string; filters?: Record<string, string>; expect: { category_slug?: string; service_slug?: string; package_slugs?: string[] } }
const cases = readFileSync(setPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Case)
const anon = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!, { auth: { persistSession: false } })

async function main() {
  let hits = 0
  const byCat = new Map<string, { n: number; hit: number }>()
  for (const c of cases) {
    const { data, error } = await anon.rpc('search_packages_v2', {
      p_query: c.query, p_category_slug: c.filters?.['category'] ?? null, p_service_slug: c.filters?.['service'] ?? null, p_state: c.filters?.['state'] ?? null,
      p_city: null, p_credential: null, p_response_max_minutes: null, p_delivery_max_days: null, p_min_price: null, p_max_price: null, p_min_rating: null, p_language: null, p_verified_only: false,
      p_sort: 'best', p_limit: k, p_offset: 0,
    })
    if (error) throw new Error(`${c.id}: ${error.message}`)
    const top = (data ?? []) as { category_slug?: string; service_slug?: string | null; package_slug?: string }[]
    const ok = top.some((r) =>
      (c.expect.category_slug ? r.category_slug === c.expect.category_slug : true) &&
      (c.expect.package_slugs ? c.expect.package_slugs.includes(r.package_slug ?? '') : true))
    if (ok) hits++
    const key = c.expect.category_slug ?? 'other'
    const m = byCat.get(key) ?? { n: 0, hit: 0 }
    m.n++; if (ok) m.hit++
    byCat.set(key, m)
    if (!ok) console.log(`  · ${c.id.padEnd(34)} "${c.query}" → ${top.map((r) => r.category_slug).join(', ') || 'no results'}`)
  }
  const rate = cases.length ? hits / cases.length : 0
  console.log('')
  for (const [cat, m] of [...byCat.entries()].sort()) console.log(`  ${cat.padEnd(24)} ${m.hit}/${m.n}`)
  console.log(`\nhit@${k}: ${hits}/${cases.length} (${(rate * 100).toFixed(1)} %) — threshold ${(min * 100).toFixed(0)} %`)
  process.exit(rate >= min ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
