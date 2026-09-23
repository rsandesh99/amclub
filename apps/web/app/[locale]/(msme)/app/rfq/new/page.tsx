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
import { RfqForm, type RfqCategoryOption, type RfqPrefill } from '@/components/rfq/RfqForm'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function NewRfqPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; assistant?: string; category?: string; q?: string }>
}) {
  const { from, assistant, category, q } = await searchParams
  const user = await getSessionUser()
  if (!user) {
    // Keep the prefill (?category= / ?q=) through sign-in (E0 / U1).
    const qs = new URLSearchParams(Object.entries({ category, q }).filter((e): e is [string, string] => !!e[1])).toString()
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
    const name = (c.name_i18n as { en: string; hi?: string })
    return {
      slug: c.slug as string,
      name: (locale === 'hi' && name.hi) ? name.hi : name.en,
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

  // S1.8 — document intake button only for cohorted buyers (flag off: no setting is read, nothing renders).
  const documentIntakeEnabled = AGENT_ENABLED ? await isAgentEnabledForUser(await createAdminClient(), 'document_intake', user.id) : false

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('new_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('new_subtitle')}</p>
      </div>
      <RfqForm categories={categories} documentIntakeEnabled={documentIntakeEnabled} prefill={prefill} />
    </div>
  )
}
