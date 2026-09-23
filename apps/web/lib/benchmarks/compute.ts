import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BENCHMARK_GATE_REASONS,
  BENCHMARK_VERSION,
  BENCHMARK_WINDOW_DAYS,
  computeBenchmark,
  groupBenchmarkKeys,
  isGated,
  type BenchmarkGateReason,
  type BenchmarkSourceRow,
} from '@amclub/shared'
import { getBenchmarkSettings } from '@/lib/benchmarks/settings'

/**
 * S3.2 — the nightly fair-price compute. No model: `benchmark_inputs` returns one row per eligible PAID services order
 * in the window, the pure formula in @amclub/shared gates and summarises each (category, state) and (category,
 * national) key, and `replace_price_benchmarks` writes the result in ONE transaction — a key that fell below a gate
 * disappears the same night; unchanged rows are not touched, so a second run the same day changes nothing. The ids in
 * the inputs never leave this function. A no-op (writes nothing) unless `benchmark_compute_enabled`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const BENCHMARK_PAGE = 1000

export interface BenchmarkComputeResult {
  enabled: boolean
  version: string
  inputs: number
  keys_considered: number
  rows_written: number
  unchanged: number
  deleted: number
  gated_by_reason: Record<BenchmarkGateReason, number>
  ms: number
}

const emptyReasons = (): Record<BenchmarkGateReason, number> => Object.fromEntries(BENCHMARK_GATE_REASONS.map((r) => [r, 0])) as Record<BenchmarkGateReason, number>

async function readInputs(admin: SupabaseClient, since: string, onlyCategories: readonly string[] | null): Promise<BenchmarkSourceRow[]> {
  const out: BenchmarkSourceRow[] = []
  for (let from = 0; ; from += BENCHMARK_PAGE) {
    let q = admin.rpc('benchmark_inputs', { p_since: since }).order('seq', { ascending: true }).range(from, from + BENCHMARK_PAGE - 1)
    if (onlyCategories) q = q.in('category_slug', [...onlyCategories])
    const { data, error } = await q
    if (error) throw new Error(`benchmark_inputs: ${error.message}`)
    const rows = (data ?? []) as any[]
    for (const r of rows) {
      out.push({
        category_slug: String(r.category_slug),
        state: r.state ? String(r.state) : null,
        price_paise: Number(r.price_paise),
        provider_id: String(r.provider_id),
        msme_id: String(r.msme_id),
        delivery_days: r.delivery_days == null ? null : Number(r.delivery_days),
      })
    }
    if (rows.length < BENCHMARK_PAGE) break
  }
  return out
}

/**
 * `onlyCategories` restricts the run (inputs AND which rows may be deleted) to named categories — the verify rig's
 * own test category; never the cron. `force` bypasses the switch (the verify rig only). The cron calls
 * computeBenchmarks(admin) with neither.
 */
export async function computeBenchmarks(admin: SupabaseClient, opts: { now?: Date; force?: boolean; onlyCategories?: string[] } = {}): Promise<BenchmarkComputeResult> {
  const started = Date.now()
  const now = opts.now ?? new Date()
  const settings = await getBenchmarkSettings(admin)
  const gated_by_reason = emptyReasons()
  if (!settings.computeEnabled && !opts.force) {
    return { enabled: false, version: BENCHMARK_VERSION, inputs: 0, keys_considered: 0, rows_written: 0, unchanged: 0, deleted: 0, gated_by_reason, ms: Date.now() - started }
  }
  const since = new Date(now.getTime() - BENCHMARK_WINDOW_DAYS * 86400 * 1000).toISOString()
  const only = opts.onlyCategories && opts.onlyCategories.length ? opts.onlyCategories : null
  const inputs = await readInputs(admin, since, only)
  const groups = groupBenchmarkKeys(inputs)
  const rows: Record<string, unknown>[] = []
  for (const { key, rows: keyRows } of groups.values()) {
    const out = computeBenchmark(keyRows, settings.gates)
    if (isGated(out)) {
      gated_by_reason[out.gated]++
      continue
    }
    rows.push({ category_slug: key.category_slug, specialization: null, scope: key.scope, state: key.state, window_days: BENCHMARK_WINDOW_DAYS, ...out })
  }
  const { data, error } = await admin.rpc('replace_price_benchmarks', { p_version: BENCHMARK_VERSION, p_rows: rows, p_categories: only })
  if (error) throw new Error(`replace_price_benchmarks: ${error.message}`)
  const r = (data ?? {}) as { deleted?: number; updated?: number; inserted?: number }
  const written = Number(r.updated ?? 0) + Number(r.inserted ?? 0)
  return {
    enabled: true,
    version: BENCHMARK_VERSION,
    inputs: inputs.length,
    keys_considered: groups.size,
    rows_written: written,
    unchanged: rows.length - written,
    deleted: Number(r.deleted ?? 0),
    gated_by_reason,
    ms: Date.now() - started,
  }
}
