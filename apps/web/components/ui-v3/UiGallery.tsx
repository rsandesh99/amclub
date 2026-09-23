'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Package, ShieldCheck } from 'lucide-react'
import type { ActionItem } from '@amclub/shared'
import { INDIAN_STATES } from '@/lib/constants/india'
import { formatINR } from '@/lib/format'
import { SegmentedControl } from './SegmentedControl'
import { Picker } from './Picker'
import { Sheet } from './Sheet'
import { GroupedRow, GroupedSection } from './GroupedList'
import { StatChip, StatTile } from './StatTile'
import { DataTable } from './DataTable'
import { Banner, CountBadge, EmptyState, Skeleton } from './Feedback'
import { Stepper } from './Stepper'
import { ActionList } from './ActionList'

const SWATCHES = ['background', 'surface', 'sunken', 'muted', 'primary', 'primary-soft', 'success', 'warning', 'danger', 'verified', 'accent', 'border'] as const
const TYPE = ['t-large-title', 't-title-1', 't-title-2', 't-title-3', 't-headline', 't-body', 't-callout', 't-subhead', 't-footnote', 't-money-l', 't-money-m', 't-numeric-s'] as const

const NOW = Date.now()
const SAMPLE_ACTIONS: ActionItem[] = [
  { kind: 'quotes_waiting', objectId: 'r1', title: 'GST returns FY 25-26', action: null, count: 3, dueAt: new Date(NOW + 30 * 3600e3).toISOString(), href: '/admin/dev/ui' },
  { kind: 'order_action', objectId: 'o1', title: 'Trademark filing', action: 'review_delivery', count: null, dueAt: new Date(NOW + 70 * 3600e3).toISOString(), href: '/admin/dev/ui' },
  { kind: 'order_action', objectId: 'o2', title: 'Udyam registration', action: 'share_requirements', count: null, dueAt: null, href: '/admin/dev/ui' },
]

function Panel({ density, children }: { density: 'comfortable' | 'compact'; children: React.ReactNode }) {
  return (
    <div data-density={density} className="min-w-0 flex-1 space-y-6 rounded-modal bg-background p-4 shadow-xs">
      <p className="t-footnote font-medium text-foreground-secondary">{density}</p>
      {children}
    </div>
  )
}

export function UiGallery() {
  const t = useTranslations('dev_ui')
  const [seg, setSeg] = useState<'extra' | 'included' | 'na'>('extra')
  const [state, setState] = useState<string | null>('TS')
  const [sheet, setSheet] = useState(false)

  const block = (density: 'comfortable' | 'compact') => (
    <Panel density={density}>
      <GroupedSection header={t('segmented')}>
        <div className="p-3">
          <SegmentedControl
            ariaLabel={t('gst')}
            value={seg}
            onChange={setSeg}
            options={[{ value: 'extra', label: t('gst_extra') }, { value: 'included', label: t('gst_included') }, { value: 'na', label: t('gst_na') }]}
          />
        </div>
      </GroupedSection>
      <GroupedSection header={t('picker')}>
        <div className="p-3">
          <Picker label={t('state')} value={state} onChange={setState} options={INDIAN_STATES} allowClear recentKey="devui_state" />
        </div>
      </GroupedSection>
      <GroupedSection header={t('grouped')} footer={t('grouped_footer')}>
        <GroupedRow leading={<Package className="h-5 w-5" strokeWidth={1.5} />} title={t('row_title')} subtitle={t('row_subtitle')} value={formatINR(353882)} href="/admin/dev/ui" />
        <GroupedRow leading={<ShieldCheck className="h-5 w-5" strokeWidth={1.5} />} title={t('row_verified')} trailing={<CountBadge count={3} />} chevron />
        <GroupedRow title={t('row_destructive')} tone="critical" onClick={() => {}} />
      </GroupedSection>
      <ActionList items={SAMPLE_ACTIONS} />
      <div className="grid grid-cols-2 gap-2">
        <StatTile value="96 %" label={t('on_time')} note={t('sample_note', { n: 126 })} srLabel={t('on_time_sr', { pct: 96, n: 126 })} />
        <StatTile value="38 %" label={t('repeat')} note={t('sample_note', { n: 54 })} />
      </div>
      <div className="flex flex-wrap gap-2"><StatChip>96 % {t('on_time')}</StatChip><StatChip>{t('replies_2h')}</StatChip></div>
      <DataTable
        caption={t('table')}
        rowKey={(r) => r.id}
        stickyFirstColumn
        columns={[
          { key: 'req', header: t('col_requirement'), render: (r) => r.title },
          { key: 'budget', header: t('col_budget'), align: 'right', render: (r) => formatINR(r.budget) },
          { key: 'quotes', header: t('col_quotes'), align: 'right', render: (r) => `${r.quotes} / 7` },
        ]}
        rows={[{ id: '1', title: 'GST returns FY 25-26', budget: 500000, quotes: 3 }, { id: '2', title: 'Factory licence renewal', budget: 1000000, quotes: 1 }]}
      />
      <Stepper ariaLabel={t('stepper')} steps={[t('step_contact'), t('step_business'), t('step_credentials'), t('step_review')]} current={1} />
      <Banner tone="caution" title={t('banner_title')}>{t('banner_body')}</Banner>
      <Banner tone="critical">{t('banner_critical')}</Banner>
      <EmptyState title={t('empty_title')} body={t('empty_body')} />
      <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
      <button type="button" onClick={() => setSheet(true)} className="rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">{t('open_sheet')}</button>
    </Panel>
  )

  return (
    <div data-ui="v3" className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-8">
        <header>
          <h1 className="t-large-title">{t('title')}</h1>
          <p className="t-subhead mt-1 text-foreground-secondary">{t('subtitle')}</p>
        </header>
        <section className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {SWATCHES.map((s) => (
            <div key={s} className="overflow-hidden rounded-card bg-surface shadow-xs">
              <div className="h-12" style={{ background: `rgb(var(--c-${s}))` }} />
              <p className="t-footnote px-2 py-1 text-foreground-secondary">{s}</p>
            </div>
          ))}
        </section>
        <section className="space-y-1 rounded-sheet bg-surface p-4 shadow-xs">
          {TYPE.map((c) => <p key={c} className={c}>{c.replace('t-', '')} · {formatINR(176882)}</p>)}
        </section>
        <div className="flex flex-col gap-4 lg:flex-row">
          {block('comfortable')}
          {block('compact')}
        </div>
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title={t('sheet_title')} description={t('sheet_body')} footer={<button type="button" onClick={() => setSheet(false)} className="h-11 w-full rounded-button bg-primary font-semibold text-primary-foreground">{t('done')}</button>}>
        <p className="t-body text-foreground-secondary">{t('sheet_content')}</p>
      </Sheet>
    </div>
  )
}
