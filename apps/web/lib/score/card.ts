import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUYER_COMPONENTS,
  PROVIDER_COMPONENTS,
  SAMPLE_GATES_V1,
  SCORE_VERSION,
  scoreNoteProblems,
  scoreTip,
  stubScoreNote,
  toScoreTipLocale,
  weakestComponents,
  type ComponentResult,
  type ProviderComponent,
} from '@amclub/shared'
import { buildScoreNoteParts, scoreNoteAllowedNumbers, scoreNoteSchema, type ScoreNoteInput } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { boundedChatJson } from '@/lib/agent/bounded'
import { istDate } from '@/lib/score/compute'

/**
 * S2.4 — the AMC Score payloads (ADR-010 §6). The provider card is the provider's OWN snapshot (the route resolves
 * the provider from the session); the admin blocks add the raw counts and the last score events. No buyer-reachable
 * route ever calls these.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CardComponent { key: string; value: number | null; weight: number; sample: number; raw: Record<string, number | null> }

export interface ProviderScoreCard {
  version: string
  computed: boolean
  score: number | null
  gated: boolean
  gate: { needed: { closed_orders: number; response_samples: number }; have: { closed_orders: number; response_samples: number } }
  components: CardComponent[]
  weakest: ProviderComponent[]
  tips: { key: ProviderComponent; text: string }[]
  trend: { on: string; score: number | null }[]
  note: string | null
  computed_at: string | null
}

function componentsOf<C extends string>(raw: unknown, order: readonly C[]): Record<C, ComponentResult> {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  return Object.fromEntries(order.map((k) => {
    const c = obj[k] ?? {}
    return [k, { value: typeof c.value === 'number' ? c.value : null, sample: Number(c.sample ?? 0), raw: (c.raw && typeof c.raw === 'object' ? c.raw : {}) as Record<string, number | null>, weight: Number(c.weight ?? 0) }]
  })) as Record<C, ComponentResult>
}

const list = <C extends string>(c: Record<C, ComponentResult>, order: readonly C[]): CardComponent[] => order.map((k) => ({ key: k, value: c[k].value, weight: c[k].weight, sample: c[k].sample, raw: c[k].raw }))

async function trendOf(admin: SupabaseClient, subjectType: 'provider' | 'buyer', subjectId: string): Promise<{ on: string; score: number | null }[]> {
  const { data } = await admin.from('score_history').select('computed_on, score').eq('subject_type', subjectType).eq('subject_id', subjectId).eq('score_version', SCORE_VERSION).order('computed_on', { ascending: false }).limit(30)
  return (((data as any[]) ?? []).reverse()).map((h) => ({ on: String(h.computed_on), score: h.score ?? null }))
}

/**
 * The day's coaching note (score_note@v1): only for a Munshi-enabled provider (AGENT_ENABLED + agents_enabled.munshi
 * + cohort); cached on the snapshot per IST day + locale; null on any failure or policy problem (the deterministic
 * tips still render). Informational — no ai_decisions row.
 */
async function coachingNote(admin: SupabaseClient, args: { userId: string; providerId: string; locale: string; cached: any; input: ScoreNoteInput }): Promise<string | null> {
  const today = istDate()
  if (args.cached && args.cached.on === today && args.cached.locale === args.locale && typeof args.cached.text === 'string') return args.cached.text
  try {
    const res = await boundedChatJson(admin, {
      userId: args.userId,
      feature: 'score',
      taskClass: 'score_note',
      promptId: 'score_note',
      promptVersion: 'v1',
      schema: scoreNoteSchema,
      parts: buildScoreNoteParts(args.input),
      temperature: 0.3,
      stub: () => stubScoreNote(args.locale, args.input.weakest[0] ?? null),
      meta: { provider_id: args.providerId },
    })
    const note = res.data.note
    if (scoreNoteProblems(note, scoreNoteAllowedNumbers(args.input)).length) return null
    await admin.from('provider_scores').update({ note: { on: today, locale: args.locale, text: note } }).eq('provider_id', args.providerId).eq('score_version', SCORE_VERSION)
    return note
  } catch (e) {
    console.warn('[score] coaching note unavailable', (e as Error).message)
    return null
  }
}

export async function providerScoreCard(admin: SupabaseClient, args: { providerId: string; userId: string; locale: string | null | undefined }): Promise<ProviderScoreCard> {
  const locale = toScoreTipLocale(args.locale)
  const gateNeed = { closed_orders: SAMPLE_GATES_V1.provider.closed_orders, response_samples: SAMPLE_GATES_V1.provider.response_samples }
  const { data: snap } = await admin.from('provider_scores').select('score, gated, components, sample, note, computed_at').eq('provider_id', args.providerId).eq('score_version', SCORE_VERSION).maybeSingle()
  if (!snap) {
    return { version: SCORE_VERSION, computed: false, score: null, gated: true, gate: { needed: gateNeed, have: { closed_orders: 0, response_samples: 0 } }, components: [], weakest: [], tips: [], trend: [], note: null, computed_at: null }
  }
  const s = snap as any
  const components = componentsOf(s.components, PROVIDER_COMPONENTS)
  const weakest = weakestComponents(components, PROVIDER_COMPONENTS)
  const have = { closed_orders: Number(s.sample?.closed_orders ?? 0), response_samples: Number(s.sample?.response_samples ?? 0) }
  const noteOn = AGENT_ENABLED && (await isAgentEnabledForUser(admin, 'munshi', args.userId))
  const input: ScoreNoteInput = { locale, score: s.score ?? null, gated: !!s.gated, gate: { closed_orders: have.closed_orders, needed: gateNeed.closed_orders }, components, weakest }
  return {
    version: SCORE_VERSION,
    computed: true,
    score: s.gated ? null : (s.score ?? null),
    gated: !!s.gated,
    gate: { needed: gateNeed, have },
    components: list(components, PROVIDER_COMPONENTS),
    weakest,
    tips: weakest.map((k) => ({ key: k, text: scoreTip(k, locale) })),
    trend: await trendOf(admin, 'provider', args.providerId),
    note: noteOn ? await coachingNote(admin, { userId: args.userId, providerId: args.providerId, locale, cached: s.note, input }) : null,
    computed_at: s.computed_at ?? null,
  }
}

/** Admin: either side, with the raw counts (in each component) and the last 10 score events. */
export async function adminScoreBlock(admin: SupabaseClient, side: 'provider' | 'buyer', subjectId: string): Promise<{ version: string; computed: boolean; score: number | null; gated: boolean; sample: Record<string, number>; components: CardComponent[]; trend: { on: string; score: number | null }[]; events: { delta: number; from_score: number | null; to_score: number | null; reason: string; created_at: string }[]; computed_at: string | null }> {
  const table = side === 'provider' ? 'provider_scores' : 'buyer_scores'
  const idCol = side === 'provider' ? 'provider_id' : 'msme_id'
  const { data: snap } = await admin.from(table).select('score, gated, components, sample, computed_at').eq(idCol, subjectId).eq('score_version', SCORE_VERSION).maybeSingle()
  const { data: evs } = await admin.from('score_events').select('delta, from_score, to_score, reason, created_at').eq('subject_type', side).eq('subject_id', subjectId).eq('score_version', SCORE_VERSION).order('created_at', { ascending: false }).limit(10)
  const s = snap as any
  const order = side === 'provider' ? PROVIDER_COMPONENTS : BUYER_COMPONENTS
  return {
    version: SCORE_VERSION,
    computed: !!s,
    score: s?.score ?? null,
    gated: s ? !!s.gated : true,
    sample: (s?.sample ?? {}) as Record<string, number>,
    components: s ? list(componentsOf(s.components, order as readonly string[]), order as readonly string[]) : [],
    trend: await trendOf(admin, side, subjectId),
    events: ((evs as any[]) ?? []),
    computed_at: s?.computed_at ?? null,
  }
}

export interface ScoreStats {
  version: string
  provider: SideStats
  buyer: SideStats
  movers_week: { subject_type: string; subject_id: string; delta: number; reason: string }[]
}
interface SideStats { subjects: number; scored: number; gated_share_pct: number | null; median: number | null; histogram: number[] }

function sideStats(rows: { score: number | null; gated: boolean }[]): SideStats {
  const scored = rows.filter((r) => !r.gated && r.score !== null).map((r) => r.score as number).sort((a, b) => a - b)
  const histogram = Array.from({ length: 10 }, () => 0)
  for (const s of scored) histogram[Math.min(9, Math.floor(s / 10))]!++
  return {
    subjects: rows.length,
    scored: scored.length,
    gated_share_pct: rows.length ? Math.round(((rows.length - scored.length) / rows.length) * 100) : null,
    median: scored.length ? scored[Math.floor(scored.length / 2)]! : null,
    histogram,
  }
}

/** The admin tile: distribution per side (10-point buckets), gated share, median, this week's biggest movers. */
export async function scoreStats(admin: SupabaseClient): Promise<ScoreStats> {
  const [{ data: p }, { data: b }, { data: ev }] = await Promise.all([
    admin.from('provider_scores').select('score, gated').eq('score_version', SCORE_VERSION),
    admin.from('buyer_scores').select('score, gated').eq('score_version', SCORE_VERSION),
    admin.from('score_events').select('subject_type, subject_id, delta, reason').eq('score_version', SCORE_VERSION).gte('created_at', new Date(Date.now() - 7 * 86400 * 1000).toISOString()),
  ])
  const movers = ((ev as any[]) ?? []).filter((e) => e.reason !== 'gate').sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 10)
  return { version: SCORE_VERSION, provider: sideStats((p as any[]) ?? []), buyer: sideStats((b as any[]) ?? []), movers_week: movers }
}
