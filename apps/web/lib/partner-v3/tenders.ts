import 'server-only'
import { isReviewFresh, type TenderValueBand } from '@amclub/shared'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { todayIST } from '@/lib/agent/quote-extract'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * PRD Experience v3 E11 FR-11.6 (N30; gated by D9 + its mini-PRD) — tender
 * ALERTS and the GeM checklist. Dark behind agent_settings.tenders_enabled.
 * Alerts only: a title, department, value band, closing date and the official
 * portal link. There is no bidding, applying or submitting inside AMClub.
 */
export async function isTendersOn(admin?: Admin): Promise<boolean> {
  return (await getAgentSetting(admin ?? (await createAdminClient()), 'tenders_enabled').catch(() => false)) === true
}

export const TENDER_CATEGORY = 'government-licensing'

export interface TenderAlertView { id: string; title: string; department: string; valueBand: TenderValueBand | null; closesOn: string; portalUrl: string; saved: boolean }

/** Verified (active) providers in the government-and-licensing category only; matched by category + state. */
export async function listTenderAlerts(admin: Admin, providerId: string): Promise<TenderAlertView[] | 'not_eligible'> {
  const { data: p } = await admin.from('provider_profiles').select('status, state').eq('id', providerId).maybeSingle()
  const { data: cats } = await admin.from('provider_categories').select('category:categories(slug)').eq('provider_id', providerId)
  const slugs = (cats ?? []).map((c) => { const x = c.category as { slug?: string } | { slug?: string }[] | null; return Array.isArray(x) ? x[0]?.slug : x?.slug }).filter((s): s is string => !!s)
  if (p?.status !== 'active' || !slugs.includes(TENDER_CATEGORY)) return 'not_eligible'
  const { data: alerts } = await admin
    .from('tender_alerts')
    .select('id, title, department, value_band, closes_on, portal_url, category_slugs, states')
    .is('deleted_at', null)
    .gte('closes_on', todayIST())
    .overlaps('category_slugs', slugs)
    .order('closes_on', { ascending: true })
    .limit(100)
  const { data: fb } = await admin.from('tender_feedback').select('alert_id, verdict').eq('provider_id', providerId)
  const verdict = new Map((fb ?? []).map((f) => [f.alert_id as string, f.verdict as string]))
  return ((alerts ?? []) as { id: string; title: string; department: string; value_band: TenderValueBand | null; closes_on: string; portal_url: string; states: string[] }[])
    .filter((a) => a.states.length === 0 || (p.state && a.states.includes(p.state as string)))
    .filter((a) => verdict.get(a.id) !== 'not_relevant')
    .map((a) => ({ id: a.id, title: a.title, department: a.department, valueBand: a.value_band, closesOn: a.closes_on, portalUrl: a.portal_url, saved: verdict.get(a.id) === 'saved' }))
}

export async function recordTenderFeedback(admin: Admin, providerId: string, alertId: string, verdict: 'saved' | 'not_relevant'): Promise<boolean> {
  const { data: a } = await admin.from('tender_alerts').select('id').eq('id', alertId).is('deleted_at', null).maybeSingle()
  if (!a) return false
  const { error } = await admin.from('tender_feedback').upsert({ provider_id: providerId, alert_id: alertId, verdict }, { onConflict: 'provider_id,alert_id' })
  return !error
}

export interface CmsPageView { title: string; items: string[]; reviewedBy: string; reviewedAt: string }

/** A reviewed CMS page, only while its review is fresh (≤ 180 days; RLS says the same). */
export async function getReviewedPage(slug: string, locale: string): Promise<CmsPageView | null> {
  const { data } = await createPublicClient().from('cms_pages').select('title_i18n, body_i18n, reviewed_by, reviewed_at').eq('slug', slug).maybeSingle()
  if (!data || !isReviewFresh(data.reviewed_at as string | null)) return null
  const pick = <T,>(m: Record<string, T> | null): T | undefined => (m ? (m[locale] ?? m['en']) : undefined)
  const items = pick(data.body_i18n as Record<string, string[]> | null)
  return { title: pick(data.title_i18n as Record<string, string> | null) ?? slug, items: Array.isArray(items) ? items : [], reviewedBy: data.reviewed_by as string, reviewedAt: data.reviewed_at as string }
}
