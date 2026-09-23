import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { benchmarkExplainSchema, buildBenchmarkExplainParts } from '@amclub/agent-core'
import {
  BENCHMARK_VERSION,
  benchmarkNoteViolations,
  benchmarkViewSchema,
  stubBenchmarkNote,
  toBenchmarkLocale,
  type BenchmarkView,
} from '@amclub/shared'
import { AGENT_ENABLED } from '@/lib/flags'
import { boundedChatJson } from '@/lib/agent/bounded'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { getBenchmarkSettings } from '@/lib/benchmarks/settings'

/**
 * S3.2 — the ONE read behind every surface (buyer RFQ page, provider RFQ page, GET /rfq/[id], mobile). Services only;
 * `benchmark_display_enabled` or nothing; the buyer's state row, else the national row, else null — and null renders
 * NOTHING (no empty state, no "not enough data"). The buyer and every matched provider get the same row for the same
 * request (matched providers are in-state by the fan-out, so the state name tells them nothing new). The view is
 * parsed with the strict schema, so an id can never reach a page or the API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const COLS = 'category_slug, scope, state, p25_paise, p50_paise, p75_paise, median_delivery_days, p25_delivery_days, p75_delivery_days, sample_n, providers_n, computed_at, notes'

export interface BenchmarkForArgs {
  rfqId: string
  kind: 'service' | 'goods'
  categorySlug: string | null
  /** the viewer (buyer or matched provider) — only the optional note depends on who is looking */
  viewerUserId: string
  locale: string | null | undefined
}

export async function getBenchmarkFor(admin: SupabaseClient, args: BenchmarkForArgs): Promise<BenchmarkView | null> {
  if (args.kind !== 'service' || !args.categorySlug) return null
  try {
    const settings = await getBenchmarkSettings(admin)
    if (!settings.displayEnabled) return null
    // the buyer's state through rfqs.msme_id (never a staged column)
    const { data: r } = await admin.from('rfqs').select('msme:msme_profiles!inner(state)').eq('id', args.rfqId).maybeSingle()
    const state = ((r as any)?.msme?.state as string | null | undefined) || null
    const { data: rows, error } = await admin.from('price_benchmarks').select(COLS).eq('version', BENCHMARK_VERSION).eq('category_slug', args.categorySlug).is('specialization', null)
    if (error) return null
    const list = (rows ?? []) as any[]
    const row = (state ? list.find((x) => x.scope === 'state' && x.state === state) : null) ?? list.find((x) => x.scope === 'national') ?? null
    if (!row) return null
    const base = {
      category_slug: String(row.category_slug),
      scope: row.scope,
      state: row.scope === 'state' ? String(row.state) : null,
      p25_paise: Number(row.p25_paise),
      p50_paise: Number(row.p50_paise),
      p75_paise: Number(row.p75_paise),
      median_delivery_days: row.median_delivery_days == null ? null : Number(row.median_delivery_days),
      p25_delivery_days: row.p25_delivery_days == null ? null : Number(row.p25_delivery_days),
      p75_delivery_days: row.p75_delivery_days == null ? null : Number(row.p75_delivery_days),
      sample_n: Number(row.sample_n),
      providers_n: Number(row.providers_n),
      computed_at: String(row.computed_at),
      note: null as string | null,
    }
    const noteOn = AGENT_ENABLED && (await isAgentEnabledForUser(admin, 'benchmark', args.viewerUserId))
    if (noteOn) base.note = await explainNote(admin, { row, view: base, locale: toBenchmarkLocale(args.locale), userId: args.viewerUserId })
    const parsed = benchmarkViewSchema.safeParse(base)
    return parsed.success ? parsed.data : null
  } catch (e) {
    console.warn('[benchmarks] view unavailable', (e as Error).message)
    return null
  }
}

/**
 * The optional sentence (benchmark_explain@v1): trusted numbers only, cached on the row per (computed_at, locale);
 * null on any failure or policy problem (the fixed line alone renders). Informational — no ai_decisions row.
 */
async function explainNote(admin: SupabaseClient, a: { row: any; view: Omit<BenchmarkView, 'note'> & { note: string | null }; locale: string; userId: string }): Promise<string | null> {
  const cached = a.row.notes as { computed_at?: string; by_locale?: Record<string, string> } | null
  if (cached && cached.computed_at === a.view.computed_at && typeof cached.by_locale?.[a.locale] === 'string') return cached.by_locale[a.locale]!
  try {
    const input = { ...a.view, locale: a.locale }
    const res = await boundedChatJson(admin, {
      userId: a.userId,
      feature: 'benchmark',
      taskClass: 'benchmark_explain',
      promptId: 'benchmark_explain',
      promptVersion: 'v1',
      schema: benchmarkExplainSchema,
      parts: buildBenchmarkExplainParts(input),
      temperature: 0.2,
      stub: () => stubBenchmarkNote(a.view, a.locale),
      meta: { category_slug: a.view.category_slug, scope: a.view.scope },
    })
    const note = res.data.note
    if (benchmarkNoteViolations(note, a.view).length) return null
    // only onto the same numbers: a row recomputed meanwhile keeps its own (cleared) note
    const by_locale = { ...(cached?.computed_at === a.view.computed_at ? (cached?.by_locale ?? {}) : {}), [a.locale]: note }
    const cache = { computed_at: a.view.computed_at, by_locale }
    let q = admin.from('price_benchmarks').update({ notes: cache }).eq('version', BENCHMARK_VERSION).eq('category_slug', a.view.category_slug).eq('scope', a.view.scope).is('specialization', null).eq('computed_at', a.view.computed_at)
    q = a.view.state ? q.eq('state', a.view.state) : q.is('state', null)
    await q
    return note
  } catch (e) {
    console.warn('[benchmarks] note unavailable', (e as Error).message)
    return null
  }
}
