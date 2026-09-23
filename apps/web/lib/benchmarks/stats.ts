import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BENCHMARK_VERSION } from '@amclub/shared'
import { getBenchmarkSettings } from '@/lib/benchmarks/settings'

/**
 * S3.2 — the agents-console tile: the switches, the last nightly run (keys considered, rows written, gated by reason)
 * and the table itself (aggregates only — the review surface for the two-week compute-before-display period).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BenchmarkStatsRow {
  category_slug: string
  scope: 'state' | 'national'
  state: string | null
  p25_paise: number
  p50_paise: number
  p75_paise: number
  median_delivery_days: number | null
  sample_n: number
  providers_n: number
  buyers_n: number
  computed_at: string
}

export interface BenchmarkStats {
  version: string
  compute_enabled: boolean
  display_enabled: boolean
  rows_total: number
  last_run: { at: string; result: Record<string, unknown> | null } | null
  rows: BenchmarkStatsRow[]
}

export async function benchmarkStats(admin: SupabaseClient): Promise<BenchmarkStats> {
  const settings = await getBenchmarkSettings(admin)
  const [{ data, count }, { data: hb }] = await Promise.all([
    admin
      .from('price_benchmarks')
      .select('category_slug, scope, state, p25_paise, p50_paise, p75_paise, median_delivery_days, sample_n, providers_n, buyers_n, computed_at', { count: 'exact' })
      .eq('version', BENCHMARK_VERSION)
      .order('sample_n', { ascending: false })
      .limit(25),
    admin.from('cron_heartbeats').select('last_ok_at, last_result').eq('name', 'benchmark-compute').maybeSingle(),
  ])
  return {
    version: BENCHMARK_VERSION,
    compute_enabled: settings.computeEnabled,
    display_enabled: settings.displayEnabled,
    rows_total: count ?? 0,
    last_run: hb ? { at: String((hb as any).last_ok_at), result: ((hb as any).last_result ?? null) as Record<string, unknown> | null } : null,
    rows: ((data ?? []) as any[]).map((r) => ({
      category_slug: String(r.category_slug), scope: r.scope, state: r.state ?? null,
      p25_paise: Number(r.p25_paise), p50_paise: Number(r.p50_paise), p75_paise: Number(r.p75_paise),
      median_delivery_days: r.median_delivery_days == null ? null : Number(r.median_delivery_days),
      sample_n: Number(r.sample_n), providers_n: Number(r.providers_n), buyers_n: Number(r.buyers_n), computed_at: String(r.computed_at),
    })),
  }
}
