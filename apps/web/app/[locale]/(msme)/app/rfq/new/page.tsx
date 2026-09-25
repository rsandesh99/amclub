import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ClipboardList } from 'lucide-react'
import type { RfqTemplate } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createClient, createPublicClient, createAdminClient } from '@/lib/supabase/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { Button } from '@/components/ui/button'
import { RfqForm, type RfqCategoryOption, type RfqFormV3, type RfqPrefill } from '@/components/rfq/RfqForm'
import { budgetBandOf, indianStateName, isEmptyMustHaves, parseRfqPrefill, pickI18n, rfqMustHavesSchema, SPECIALIZATIONS, type I18nText, type RfqEntryPoint } from '@amclub/shared'
import { isOnFor } from '@/lib/experiments'
import { getAgentSetting } from '@/lib/agent/settings'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function NewRfqPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; assistant?: string; category?: string; q?: string; service?: string; from_package?: string; from_provider?: string; entry?: string }>
}) {
  const sp = await searchParams
  const { from, assistant, category, q } = sp
  const user = await getSessionUser()
  if (!user) {
    // Keep the prefill (?category= / ?q=) through sign-in (E0 / U1).
    const qs = new URLSearchParams(Object.entries({ category, q, service: sp.service, from_package: sp.from_package, from_provider: sp.from_provider, entry: sp.entry }).filter((e): e is [string, string] => !!e[1])).toString()
    redirect(`/login?next=${encodeURIComponent(`/app/rfq/new${qs ? `?${qs}` : ''}`)}`)
  }
  const t = await getTranslations('rfq')
  const locale = await getLocale()

  // §1.5 M5 / §3.3 — RFQ matching needs state + sector.
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('msme_profiles')
    .select('state, sector')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!profile?.state || !profile?.sector) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/10">
          <ClipboardList className="h-7 w-7 text-warning" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">{t('profile_incomplete_title')}</h1>
        <p className="mt-2 text-sm text-foreground-secondary">{t('profile_incomplete_body')}</p>
        <Link href="/app/profile">
          <Button className="mt-6">{t('complete_profile_cta')}</Button>
        </Link>
      </div>
    )
  }

  // Public read — categories + their seeded RFQ templates.
  const pub = createPublicClient()
  const { data: cats } = await pub
    .from('categories')
    .select('slug, name_i18n, rfq_template, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  const categories: RfqCategoryOption[] = (cats ?? []).map((c) => {
    const tpl = (c.rfq_template ?? { fields: [] }) as RfqTemplate
    return {
      slug: c.slug as string,
      // E14: the reader's own language (te / ta too), English for a missing slot.
      name: pickI18n(c.name_i18n as I18nText, locale),
      fields: tpl.fields ?? [],
    }
  })

  // "Repost with edits" (?from=<rfqId>, from the expired-RFQ notice and the compare
  // screen): copy the buyer's OWN earlier request. The user-scoped client means
  // RLS decides ownership — someone else's id simply loads nothing.
  let prefill: RfqPrefill | undefined
  if (from && UUID.test(from)) {
    const { data: prev } = await supabase
      .from('rfqs')
      .select('title, details, budget_min_paise, budget_max_paise, category:categories(slug)')
      .eq('id', from)
      .maybeSingle()
    if (prev) {
      const details = Object.fromEntries(
        Object.entries((prev.details ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>
      const cat = prev.category as { slug?: string } | { slug?: string }[] | null
      const slug = (Array.isArray(cat) ? cat[0]?.slug : cat?.slug) ?? ''
      prefill = {
        categorySlug: categories.some((c) => c.slug === slug) ? slug : '',
        title: (prev.title as string) ?? '',
        details,
        // Input display only (the form sends rupees ×100 back as paise).
        budgetMin: prev.budget_min_paise != null ? String(Number(prev.budget_min_paise) / 100) : '',
        budgetMax: prev.budget_max_paise != null ? String(Number(prev.budget_max_paise) / 100) : '',
      }
    }
  }

  // S3.1 — Edit on the procurement agent's draft card (?assistant=<session>): prefill the ordinary form from the buyer's
  // OWN session draft (the user-scoped client — RLS owner read; someone else's id loads nothing). Nothing is created here.
  if (!prefill && assistant && UUID.test(assistant)) {
    const { data: sess } = await supabase.from('procurement_sessions').select('draft').eq('id', assistant).maybeSingle()
    const payload = ((sess?.draft as { payload?: Record<string, unknown> | null } | null)?.payload ?? null) as { title?: unknown; category_slug?: unknown; details?: Record<string, unknown> } | null
    if (payload) {
      const slug = typeof payload.category_slug === 'string' ? payload.category_slug : ''
      const details = Object.fromEntries(Object.entries(payload.details ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      prefill = { categorySlug: categories.some((c) => c.slug === slug) ? slug : '', title: typeof payload.title === 'string' ? payload.title : '', details, budgetMin: '', budgetMax: '' }
    }
  }

  // E0 / U4 — "Post a requirement in <category>" from a provider page (and, in
  // E6, every other entry point): prefill the category, and the title from a
  // search query. Only a known slug is accepted; the query is trimmed and capped.
  if (!prefill && (category || q)) {
    const slug = category && categories.some((c) => c.slug === category) ? category : ''
    const title = (q ?? '').trim().slice(0, 120)
    if (slug || title) prefill = { categorySlug: slug, title, details: {}, budgetMin: '', budgetMax: '' }
  }

  // Experience v3 E6 (flag `requirements`): the prefill contract (N20), the
  // level-2 services, reviewed document suggestions, and the quote-time stat.
  let v3: RfqFormV3 | undefined
  if (isOnFor('requirements', user.id)) {
    const pre = parseRfqPrefill(sp as Record<string, string | undefined>)
    const known = (slug: string | undefined) => (slug && categories.some((c) => c.slug === slug) ? slug : '')
    if (!prefill && pre.from_package) {
      // "Need something different?" from a package page: its category + service.
      const { data: pk } = await pub.from('packages').select('category:categories(slug)').eq('id', pre.from_package).eq('status', 'active').maybeSingle()
      const { data: svc } = await pub.from('packages').select('service_slug').eq('id', pre.from_package).maybeSingle()
      const slug = known((pk?.category as { slug?: string } | null)?.slug)
      if (slug) prefill = { categorySlug: slug, title: '', details: {}, budgetMin: '', budgetMax: '', ...(svc?.service_slug ? { service: svc.service_slug as string } : {}) }
    }
    if (!prefill && pre.from_provider) {
      // From a provider profile: their category only (D-UX1). provider_profiles is not anon-readable (the public
      // view is), so this server-side lookup of an ACTIVE provider's first category uses the service role.
      const adminRead = await createAdminClient()
      const { data: pp } = await adminRead.from('provider_profiles').select('id').eq('slug', pre.from_provider).eq('status', 'active').is('deleted_at', null).maybeSingle()
      const { data: pc } = pp ? await adminRead.from('provider_categories').select('category:categories(slug)').eq('provider_id', pp.id).limit(1) : { data: null }
      const slug = known(((pc ?? [])[0]?.category as { slug?: string } | null)?.slug)
      if (slug) prefill = { categorySlug: slug, title: '', details: {}, budgetMin: '', budgetMax: '' }
    }
    if (prefill && pre.from) {
      // E9 FR-9.3 "Repeat requirement" (and every v3 repost): the service, budget band and must-haves
      // come along too; needed-by stays cleared. Own RFQ only (the user-scoped client, RLS).
      const { data: prev } = await supabase.from('rfqs').select('details, budget_min_paise, budget_max_paise, must_haves').eq('id', pre.from).maybeSingle()
      if (prev) {
        const svc = (prev.details as Record<string, unknown> | null)?.['service_slug']
        const band = budgetBandOf(prev.budget_min_paise == null ? null : Number(prev.budget_min_paise), prev.budget_max_paise == null ? null : Number(prev.budget_max_paise))
        const mh = rfqMustHavesSchema.safeParse(prev.must_haves)
        prefill = {
          ...prefill,
          ...(typeof svc === 'string' && (SPECIALIZATIONS as Record<string, readonly string[]>)[prefill.categorySlug]?.includes(svc) ? { service: svc } : {}),
          ...(band ? { budgetBand: band } : {}),
          ...(mh.success && !isEmptyMustHaves(mh.data) ? { mustHaves: mh.data } : {}),
        }
      }
    }
    if (prefill && pre.service && !prefill.service && (SPECIALIZATIONS as Record<string, readonly string[]>)[prefill.categorySlug]?.includes(pre.service)) {
      prefill = { ...prefill, service: pre.service }
    }
    const documents: RfqFormV3['documents'] = {}
    const admin = await createAdminClient()
    if ((await getAgentSetting(admin, 'document_suggestions_enabled').catch(() => false)) === true) {
      const { data: docs } = await pub
        .from('service_document_requirements')
        .select('category_slug, service_slug, doc_key, label_i18n, required, reviewed_at, sort_order')
        .not('reviewed_at', 'is', null)
        .order('sort_order', { ascending: true })
      for (const d of (docs ?? []) as { category_slug: string; service_slug: string | null; doc_key: string; label_i18n: Record<string, string>; required: boolean; reviewed_at: string }[]) {
        ;(documents[d.category_slug] ??= []).push({ key: d.doc_key, label: d.label_i18n[locale] ?? d.label_i18n['en'] ?? d.doc_key, required: d.required, service: d.service_slug, reviewedAt: d.reviewed_at })
      }
    }
    const sla: RfqFormV3['sla'] = {}
    const { data: slaRows } = await pub.from('quote_sla_stats').select('category_slug, median_minutes, n').eq('state', profile.state)
    for (const r of (slaRows ?? []) as { category_slug: string; median_minutes: number | null; n: number }[]) sla[r.category_slug] = { medianMinutes: r.median_minutes, n: r.n }
    const entry: RfqEntryPoint = pre.entry ?? (pre.from ? 'repost' : pre.from_package ? 'package' : pre.from_provider ? 'provider' : pre.q ? 'search' : 'direct')
    v3 = {
      services: SPECIALIZATIONS,
      documents,
      sla,
      stateName: indianStateName(profile.state, locale),
      entry,
    }
  }

  // S1.8 — document intake button only for cohorted buyers (flag off: no setting is read, nothing renders).
  const documentIntakeEnabled = AGENT_ENABLED ? await isAgentEnabledForUser(await createAdminClient(), 'document_intake', user.id) : false

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('new_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('new_subtitle')}</p>
      </div>
      {v3 ? (
        // The resolved prefill / entry / suggestions as data (the form applies them on the client).
        <div
          data-testid="rfq-new-v3"
          data-entry={v3.entry}
          data-prefill-category={prefill?.categorySlug ?? ''}
          data-prefill-service={prefill?.service ?? ''}
          data-prefill-band={prefill?.budgetBand ?? ''}
          data-prefill-must-haves={prefill?.mustHaves ? JSON.stringify(prefill.mustHaves) : ''}
          data-docs={Object.values(v3.documents).flat().map((d) => d.key).join(',')}
          data-sla={Object.entries(v3.sla).map(([k, v]) => `${k}:${v.medianMinutes ?? ''}:${v.n}`).join(',')}
        >
          <RfqForm categories={categories} documentIntakeEnabled={documentIntakeEnabled} prefill={prefill} v3={v3} />
        </div>
      ) : (
        <RfqForm categories={categories} documentIntakeEnabled={documentIntakeEnabled} prefill={prefill} />
      )}
    </div>
  )
}
