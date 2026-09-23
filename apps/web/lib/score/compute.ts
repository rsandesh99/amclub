import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUYER_COMPONENTS,
  PROVIDER_COMPONENTS,
  SCORE_VERSION,
  SCORE_WINDOW_DAYS,
  biggestMover,
  scoreBuyer,
  scoreProvider,
  type BuyerScoreInputs,
  type ComponentResult,
  type ProviderScoreInputs,
  type ScoreResult,
} from '@amclub/shared'
import { getScoreSettings } from '@/lib/score/settings'

/**
 * S2.4 — the nightly AMC Score compute (ADR-010). No model: the SQL functions return the windowed counts, the pure
 * formula in @amclub/shared scores them, and this writes the snapshot (only when it changed), today's history row
 * (insert-once) and a score_events row when a score moved by ≥ 1 (append-only). A second run the same day changes
 * nothing. A no-op (and writes nothing) unless `score_compute_enabled`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SCORE_PAGE = 500

export interface ComputeResult {
  enabled: boolean
  version: string
  providers: number
  buyers: number
  gated: number
  changed: number
  events: number
  ms: number
}

/** IST calendar date (the history key). */
export function istDate(d = new Date()): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Order-insensitive JSON equality (jsonb comes back with its own key order). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

const num = (v: unknown): number => (typeof v === 'number' ? v : v == null ? 0 : Number(v))
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

export function toProviderInputs(r: any): ProviderScoreInputs {
  return {
    response_samples: num(r.response_samples), median_response_hours: numOrNull(r.median_response_hours),
    delivered_orders: num(r.delivered_orders), on_time_deliveries: num(r.on_time_deliveries),
    completed_orders: num(r.completed_orders), confirmed_by_buyer: num(r.confirmed_by_buyer), auto_accepted: num(r.auto_accepted),
    closed_orders: num(r.closed_orders), disputes_at_fault: num(r.disputes_at_fault),
    matches_decided_or_closed: num(r.matches_decided_or_closed), matches_quoted: num(r.matches_quoted), matches_declined_with_reason: num(r.matches_declined_with_reason),
  }
}
export function toBuyerInputs(r: any): BuyerScoreInputs {
  return {
    confirmation_samples: num(r.confirmation_samples), median_confirmation_hours: numOrNull(r.median_confirmation_hours),
    rfqs_with_quotes: num(r.rfqs_with_quotes), rfqs_followed_through: num(r.rfqs_followed_through),
    closed_orders: num(r.closed_orders), disputes_unfounded: num(r.disputes_unfounded),
    checkout_subjects_decided: num(r.checkout_subjects_decided), checkout_subjects_paid: num(r.checkout_subjects_paid),
  }
}

interface SideSpec<C extends string> {
  kind: 'provider' | 'buyer'
  rpc: 'score_inputs_provider' | 'score_inputs_buyer'
  table: 'provider_scores' | 'buyer_scores'
  idCol: 'provider_id' | 'msme_id'
  order: readonly C[]
  score: (row: any) => ScoreResult<C>
}

const PROVIDER_SIDE: SideSpec<(typeof PROVIDER_COMPONENTS)[number]> = { kind: 'provider', rpc: 'score_inputs_provider', table: 'provider_scores', idCol: 'provider_id', order: PROVIDER_COMPONENTS, score: (r) => scoreProvider(toProviderInputs(r)) }
const BUYER_SIDE: SideSpec<(typeof BUYER_COMPONENTS)[number]> = { kind: 'buyer', rpc: 'score_inputs_buyer', table: 'buyer_scores', idCol: 'msme_id', order: BUYER_COMPONENTS, score: (r) => scoreBuyer(toBuyerInputs(r)) }

async function computeSide<C extends string>(admin: SupabaseClient, side: SideSpec<C>, since: string, now: Date, only: readonly string[] | null): Promise<{ subjects: number; gated: number; changed: number; events: number }> {
  const today = istDate(now)
  const computedAt = now.toISOString()
  let subjects = 0
  let gated = 0
  let changed = 0
  let events = 0
  for (let from = 0; ; from += SCORE_PAGE) {
    let q = admin.rpc(side.rpc, { p_since: since }).order(side.idCol, { ascending: true }).range(from, from + SCORE_PAGE - 1)
    if (only) q = q.in(side.idCol, [...only])
    const { data, error } = await q
    if (error) throw new Error(`${side.rpc}: ${error.message}`)
    const rows = (data ?? []) as any[]
    if (!rows.length) break
    const ids = rows.map((r) => r[side.idCol] as string)
    const { data: prevRows, error: pErr } = await admin.from(side.table).select(`${side.idCol}, score, gated, components, sample`).eq('score_version', SCORE_VERSION).in(side.idCol, ids)
    if (pErr) throw new Error(`${side.table} read: ${pErr.message}`)
    const prev = new Map(((prevRows ?? []) as any[]).map((p) => [p[side.idCol] as string, p]))
    const upserts: Record<string, unknown>[] = []
    const history: Record<string, unknown>[] = []
    const evs: Record<string, unknown>[] = []
    for (const r of rows) {
      const id = r[side.idCol] as string
      const res = side.score(r)
      subjects++
      if (res.gated) gated++
      const p = prev.get(id)
      const same = !!p && p.score === res.score && p.gated === res.gated && stableJson(p.components) === stableJson(res.components) && stableJson(p.sample) === stableJson(res.sample)
      if (!same) {
        changed++
        upserts.push({ [side.idCol]: id, score_version: SCORE_VERSION, score: res.score, gated: res.gated, components: res.components, sample: res.sample, computed_at: computedAt })
      }
      history.push({ subject_type: side.kind, subject_id: id, score_version: SCORE_VERSION, score: res.score, components: res.components, computed_on: today })
      const fromScore: number | null = p ? (p.score ?? null) : null
      const toScore = res.score
      if (fromScore !== toScore && !(fromScore === null && toScore === null)) {
        const delta = (toScore ?? 0) - (fromScore ?? 0)
        if (fromScore === null || toScore === null || Math.abs(delta) >= 1) {
          const reason = fromScore === null || toScore === null ? 'gate' : (biggestMover(p?.components as Partial<Record<C, ComponentResult>> | null, res.components, side.order) ?? 'gate')
          evs.push({ subject_type: side.kind, subject_id: id, score_version: SCORE_VERSION, delta, from_score: fromScore, to_score: toScore, reason, ref: { computed_on: today } })
        }
      }
    }
    if (upserts.length) {
      const { error: uErr } = await admin.from(side.table).upsert(upserts, { onConflict: `${side.idCol},score_version` })
      if (uErr) throw new Error(`${side.table} upsert: ${uErr.message}`)
    }
    // insert-once per subject per day: a second run the same day is ignored
    const { error: hErr } = await admin.from('score_history').upsert(history, { onConflict: 'subject_type,subject_id,score_version,computed_on', ignoreDuplicates: true })
    if (hErr) throw new Error(`score_history: ${hErr.message}`)
    if (evs.length) {
      const { error: eErr } = await admin.from('score_events').insert(evs)
      if (eErr) throw new Error(`score_events: ${eErr.message}`)
      events += evs.length
    }
    if (rows.length < SCORE_PAGE) break
  }
  return { subjects, gated, changed, events }
}

/**
 * `only` restricts the run to named subjects (the verify rig; never the cron). `force` bypasses the switch (the
 * verify rig only). The cron calls computeScores(admin) with neither.
 */
export async function computeScores(admin: SupabaseClient, opts: { now?: Date; force?: boolean; only?: { providers?: string[]; buyers?: string[] } } = {}): Promise<ComputeResult> {
  const started = Date.now()
  const now = opts.now ?? new Date()
  const settings = await getScoreSettings(admin)
  if (!settings.computeEnabled && !opts.force) return { enabled: false, version: SCORE_VERSION, providers: 0, buyers: 0, gated: 0, changed: 0, events: 0, ms: Date.now() - started }
  const since = new Date(now.getTime() - SCORE_WINDOW_DAYS * 86400 * 1000).toISOString()
  const p = opts.only && !opts.only.providers ? { subjects: 0, gated: 0, changed: 0, events: 0 } : await computeSide(admin, PROVIDER_SIDE, since, now, opts.only?.providers ?? null)
  const b = opts.only && !opts.only.buyers ? { subjects: 0, gated: 0, changed: 0, events: 0 } : await computeSide(admin, BUYER_SIDE, since, now, opts.only?.buyers ?? null)
  return { enabled: true, version: SCORE_VERSION, providers: p.subjects, buyers: b.subjects, gated: p.gated + b.gated, changed: p.changed + b.changed, events: p.events + b.events, ms: Date.now() - started }
}
