'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { inboxQueryToString, RFQ_BUDGET_BAND_KEYS, type InboxQuery, type InboxSort } from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'

/**
 * E11 FR-11.2 (N28) — the inbox filter bar. Every control rewrites the URL
 * (bookmarkable, shareable inside the team); the server applies the filters
 * over the provider's own matched rows. On phones the filters fold away.
 */
export function InboxFiltersV3({ query, categories, states, badgeOn }: { query: InboxQuery; categories: { value: string; label: string }[]; states: { value: string; label: string }[]; badgeOn: boolean }) {
  const t = useTranslations('partner_v3')
  const tRfq = useTranslations('rfq_v3')
  const router = useRouter()
  const analytics = useAnalytics()
  const [q, setQ] = useState(query.q ?? '')

  type Patch = { [K in keyof InboxQuery]?: InboxQuery[K] | undefined }
  function go(patch: Patch, key: string, event: 'inbox_filter_changed' | 'inbox_sorted' = 'inbox_filter_changed') {
    const merged: Patch = { ...query, ...patch, page: 1 }
    const next = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Partial<InboxQuery>
    analytics.capture(event, { device: 'web', key })
    const qs = inboxQueryToString(next)
    router.replace((qs ? `/partner/rfqs?${qs}` : '/partner/rfqs') as '/partner/rfqs')
  }
  const toggle = (k: 'closing' | 'verified' | 'files', label: string) => (
    <button
      type="button"
      aria-pressed={!!query[k]}
      onClick={() => go({ [k]: query[k] ? undefined : true }, k)}
      className={`rounded-chip border px-3 py-1 text-sm ${query[k] ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}
    >
      {label}
    </button>
  )

  // QA F19 — the Picker renders only its button; each filter gets a visible label and shows "Any" when unset.
  const field = (id: string, label: string, picker: ReactNode) => (
    <div className="w-44">
      <label htmlFor={id} className="t-footnote mb-1 block font-medium text-foreground-secondary">{label}</label>
      {picker}
    </div>
  )
  // Rendered twice (desktop row + phone disclosure), so every id carries a suffix.
  const controls = (sfx: 'd' | 'm') => (
    <div className="flex flex-wrap items-end gap-3">
      {field(`inbox-category-${sfx}`, t('f_category'), <Picker id={`inbox-category-${sfx}`} label={t('f_category')} placeholder={t('any')} value={query.category ?? null} options={categories} allowClear clearLabel={t('any')} onChange={(v) => go({ category: v ?? undefined }, 'category')} />)}
      {field(`inbox-state-${sfx}`, t('f_state'), <Picker id={`inbox-state-${sfx}`} label={t('f_state')} placeholder={t('any')} value={query.state ?? null} options={states} allowClear clearLabel={t('any')} onChange={(v) => go({ state: v ?? undefined }, 'state')} />)}
      {field(`inbox-budget-${sfx}`, t('f_budget'), <Picker id={`inbox-budget-${sfx}`} label={t('f_budget')} placeholder={t('any')} value={query.budget ?? null} options={RFQ_BUDGET_BAND_KEYS.map((b) => ({ value: b, label: tRfq(`budget_${b}` as 'budget_under2k') }))} allowClear clearLabel={t('any')} onChange={(v) => go({ budget: (v ?? undefined) as InboxQuery['budget'] }, 'budget')} />)}
      <div className="flex flex-wrap gap-2">
        {toggle('closing', t('f_closing'))}
        {badgeOn && toggle('verified', t('f_verified'))}
        {toggle('files', t('f_files'))}
      </div>
    </div>
  )

  return (
    <div className="space-y-3" data-testid="inbox-filters">
      <div className="flex flex-wrap items-center gap-3">
        <form className="min-w-[12rem] flex-1" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() || undefined }, 'q') }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if ((query.q ?? '') !== q.trim()) go({ q: q.trim() || undefined }, 'q') }} placeholder={t('search')} aria-label={t('search')} className="h-10 w-full rounded-input border border-border bg-surface px-3 text-sm" />
        </form>
        <SegmentedControl<InboxSort> ariaLabel={t('sort')} size="sm" value={query.sort} onChange={(v) => go({ sort: v }, v, 'inbox_sorted')} options={[{ value: 'newest', label: t('sort_newest') }, { value: 'closing', label: t('sort_closing') }, { value: 'budget_high', label: t('sort_budget') }]} />
      </div>
      <div className="hidden md:block">{controls('d')}</div>
      <details className="md:hidden">
        <summary className="t-footnote cursor-pointer font-medium text-primary">{t('filters')}</summary>
        <div className="mt-3">{controls('m')}</div>
      </details>
    </div>
  )
}
