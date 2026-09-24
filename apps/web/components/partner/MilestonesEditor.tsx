'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MAX_BUNDLE_DAYS, MAX_BUNDLE_MILESTONES, MIN_BUNDLE_MILESTONES, bundleProblems } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAnalytics } from '@/components/providers/posthog'

export interface EditorMilestone {
  label_i18n: { en: string; hi?: string | null }
  due_offset_days: number
  share_bps: number
}
interface Row {
  label: string
  labelHi: string
  day: string
  pct: string
}
const toRow = (m: EditorMilestone): Row => ({ label: m.label_i18n.en, labelHi: m.label_i18n.hi ?? '', day: String(m.due_offset_days), pct: String(m.share_bps / 100) })
const EMPTY: Row = { label: '', labelHi: '', day: '', pct: '' }

/**
 * E12c / ADR 021 — sell this package as a plan: 2–6 milestones, each with a
 * label, the day it is due (≤ 92 days after purchase), and its share of the
 * price (shares add up to 100 %). The buyer pays once; each milestone becomes
 * its own order and pays out on its own completion. Clearing the plan sells the
 * package as a single order again.
 */
export function MilestonesEditor({ packageId, initial }: { packageId: string; initial: EditorMilestone[] }) {
  const t = useTranslations('bundles')
  const analytics = useAnalytics()
  const [rows, setRows] = useState<Row[]>(initial.length ? initial.map(toRow) : [])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const parsed = rows.map((r) => ({ label_i18n: { en: r.label.trim(), ...(r.labelHi.trim() ? { hi: r.labelHi.trim() } : {}) }, due_offset_days: Number(r.day), share_bps: Math.round(Number(r.pct) * 100) }))
  const problems = rows.length ? bundleProblems(parsed) : []

  async function save(next: typeof parsed) {
    setBusy(true)
    setNote(null)
    const res = await fetch(`/api/v1/partner/packages/${packageId}/milestones`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ milestones: next }) })
    setBusy(false)
    if (!res.ok) return setNote({ ok: false, text: t('err_save') })
    analytics.capture('bundle_milestones_saved', { n: next.length })
    setNote({ ok: true, text: next.length ? t('saved') : t('cleared') })
  }

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const invalid = rows.length > 0 && (rows.length < MIN_BUNDLE_MILESTONES || problems.length > 0 || parsed.some((m) => !m.label_i18n.en || !(m.due_offset_days >= 1 && m.due_offset_days <= MAX_BUNDLE_DAYS) || !(m.share_bps >= 100)))

  return (
    <section className="mt-10 rounded-card border border-border bg-surface p-5" data-testid="milestones-editor">
      <h2 className="font-display text-lg font-semibold">{t('editor_title')}</h2>
      <p className="mt-1 text-sm text-foreground-secondary">{t('editor_body', { days: MAX_BUNDLE_DAYS })}</p>
      {rows.length > 0 && (
        <ol className="mt-4 space-y-3">
          {rows.map((r, i) => (
            <li key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_6rem_6rem_auto]" data-milestone={i + 1}>
              <Input aria-label={t('label', { n: i + 1 })} placeholder={t('label', { n: i + 1 })} maxLength={60} value={r.label} onChange={(e) => set(i, { label: e.target.value })} />
              <Input aria-label={t('label_hi')} placeholder={t('label_hi')} maxLength={60} value={r.labelHi} onChange={(e) => set(i, { labelHi: e.target.value })} />
              <Input aria-label={t('due_day')} placeholder={t('due_day')} inputMode="numeric" value={r.day} onChange={(e) => set(i, { day: e.target.value.replace(/[^0-9]/g, '') })} />
              <Input aria-label={t('share_pct')} placeholder={t('share_pct')} inputMode="decimal" value={r.pct} onChange={(e) => set(i, { pct: e.target.value.replace(/[^0-9.]/g, '') })} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>{t('remove')}</Button>
            </li>
          ))}
        </ol>
      )}
      {problems.includes('shares_not_10000') && <p className="mt-2 text-xs text-warning" role="status">{t('err_shares')}</p>}
      {problems.includes('offsets_not_increasing') && <p className="mt-2 text-xs text-warning" role="status">{t('err_order')}</p>}
      {note && <p className={`mt-2 text-sm ${note.ok ? 'text-success' : 'text-danger'}`} role="status">{note.text}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {rows.length < MAX_BUNDLE_MILESTONES && <Button type="button" variant="outline" onClick={() => setRows((rs) => [...rs, { ...EMPTY }])}>{t('add')}</Button>}
        {rows.length > 0 && <Button type="button" disabled={busy || invalid} onClick={() => void save(parsed)}>{t('save')}</Button>}
        {initial.length > 0 && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setRows([]); void save([]) }}>{t('clear')}</Button>}
      </div>
    </section>
  )
}
