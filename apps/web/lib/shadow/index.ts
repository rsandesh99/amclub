import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  SHADOW_MODEL_VERSION,
  cadBandError,
  cadFeaturesSchema,
  cadPriceBand,
  fitError,
  providerFitRules,
  quoteNormalizedTotal,
  rfqMustHavesSchema,
  type ShadowFeature,
} from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * E15 FR-15.5 (F10) — the ONLY writers of `shadow_predictions`. Each feature
 * has its switch (`shadow_<feature>_enabled`, default off). Everything here is
 * best-effort and outside every user path: a failure logs and returns; nothing
 * is shown, ranked or filtered by a shadow. Subject ids only.
 */
type Admin = SupabaseClient

async function isShadowOn(admin: Admin, feature: ShadowFeature): Promise<boolean> {
  try {
    return (await getAgentSetting(admin, `shadow_${feature}_enabled` as 'shadow_cad_price_band_enabled')) === true
  } catch {
    return false
  }
}

export async function recordShadow(admin: Admin, rows: { feature: ShadowFeature; subjectId: string; predicted: Record<string, unknown> }[]): Promise<number> {
  if (!rows.length) return 0
  const { error } = await admin.from('shadow_predictions').insert(rows.map((r) => ({ feature: r.feature, model_version: SHADOW_MODEL_VERSION[r.feature], subject_kind: 'rfq', subject_id: r.subjectId, predicted: r.predicted })))
  if (error) { console.warn('[shadow] record', rows[0]!.feature, error.message); return 0 }
  captureServerEvent('system', 'shadow_predicted', { feature: rows[0]!.feature, n: rows.length })
  return rows.length
}

export async function resolveShadow(admin: Admin, id: string, actual: Record<string, unknown>, error: number): Promise<boolean> {
  const { data, error: e } = await admin.from('shadow_predictions').update({ actual, error, resolved_at: new Date().toISOString() }).eq('id', id).is('resolved_at', null).select('id')
  if (e) { console.warn('[shadow] resolve', e.message); return false }
  return ((data as unknown[] | null) ?? []).length === 1
}

const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)

/** At fan-out: the CAD price band (once per RFQ) and a fit % per matched provider. Never throws. */
export async function shadowAtFanout(admin: Admin, a: { rfqId: string; providerIds: string[] }): Promise<void> {
  try {
    const [cadOn, fitOn] = await Promise.all([isShadowOn(admin, 'cad_price_band'), isShadowOn(admin, 'provider_fit')])
    if (!cadOn && !fitOn) return
    const { data: rfq } = await admin.from('rfqs').select('id, must_haves, cad_features').eq('id', a.rfqId).maybeSingle()
    if (!rfq) return
    if (cadOn) {
      const cad = cadFeaturesSchema.safeParse(rfq.cad_features)
      const { count } = await admin.from('shadow_predictions').select('id', { count: 'exact', head: true }).eq('feature', 'cad_price_band').eq('subject_id', a.rfqId)
      if (cad.success && !count) {
        const band = cadPriceBand(cad.data)
        await recordShadow(admin, [{ feature: 'cad_price_band', subjectId: a.rfqId, predicted: { low_paise: band.lowPaise, high_paise: band.highPaise, basis: band.basis } }])
      }
    }
    if (fitOn && a.providerIds.length) {
      const mh = rfqMustHavesSchema.safeParse(rfq.must_haves ?? {})
      const [{ data: provs }, { data: creds }] = await Promise.all([
        admin.from('provider_profiles').select('id, languages, completed_orders, avg_rating, review_count, next_available_on').in('id', a.providerIds),
        admin.from('provider_verifications').select('provider_id, kind').in('provider_id', a.providerIds).in('status', ['manually_approved', 'api_verified']),
      ])
      const credsBy = new Map<string, string[]>()
      for (const c of creds ?? []) credsBy.set(c.provider_id as string, [...(credsBy.get(c.provider_id as string) ?? []), c.kind as string])
      const today = todayIst()
      await recordShadow(admin, (provs ?? []).map((p) => {
        const fit = providerFitRules({
          providerLanguages: (p.languages as string[] | null) ?? [],
          providerCredentials: credsBy.get(p.id as string) ?? [],
          mustHaves: mh.success ? mh.data : null,
          completedOrders: Number(p.completed_orders ?? 0),
          avgRating: p.avg_rating == null ? null : Number(p.avg_rating),
          reviewCount: Number(p.review_count ?? 0),
          nextAvailableOn: (p.next_available_on as string | null) ?? null,
          todayIst: today,
        })
        return { feature: 'provider_fit' as const, subjectId: a.rfqId, predicted: { provider_id: p.id, fit_pct: fit.fitPct, reasons: fit.reasons } }
      }))
    }
  } catch (e) {
    console.warn('[shadow] fanout', (e as Error).message)
  }
}

/** At acceptance: resolve the RFQ's open predictions against what happened. Never throws; replay-safe (resolved rows are skipped). */
export async function shadowAtAcceptance(admin: Admin, a: { rfqId: string; acceptedQuoteId: string }): Promise<void> {
  try {
    const { data: open } = await admin.from('shadow_predictions').select('id, feature, predicted').eq('subject_kind', 'rfq').eq('subject_id', a.rfqId).is('resolved_at', null)
    if (!open?.length) return
    const { data: quotes } = await admin.from('quotes').select('id, provider_id, price_paise, gst_included').eq('rfq_id', a.rfqId)
    const winner = (quotes ?? []).find((q) => q.id === a.acceptedQuoteId)
    const quoted = new Set((quotes ?? []).map((q) => q.provider_id as string))
    let resolved = 0
    for (const row of open) {
      const p = row.predicted as Record<string, unknown>
      if (row.feature === 'cad_price_band' && winner) {
        const total = quoteNormalizedTotal({ pricePaise: Number(winner.price_paise), gstIncluded: (winner.gst_included as boolean | null) ?? null, deliveryDays: null })
        const err = cadBandError({ lowPaise: Number(p['low_paise']), highPaise: Number(p['high_paise']) }, total)
        if (await resolveShadow(admin, row.id as string, { total_paise: total, quote_id: winner.id }, err)) resolved++
      } else if (row.feature === 'provider_fit') {
        const pid = String(p['provider_id'])
        const actual = { quoted: quoted.has(pid), won: winner?.provider_id === pid }
        if (await resolveShadow(admin, row.id as string, actual, fitError(Number(p['fit_pct']), actual))) resolved++
      }
    }
    if (resolved) captureServerEvent('system', 'shadow_resolved', { rfq_id: a.rfqId, n: resolved })
  } catch (e) {
    console.warn('[shadow] acceptance', (e as Error).message)
  }
}
