'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, Layers } from 'lucide-react'
import {
  COMPARE_ROWS_MAX,
  COMPARE_TEXT_MAX,
  IDEAL_FOR_MAX,
  PACKAGE_TIERS,
  packageGroupUpsertSchema,
  type CompareValue,
  type PackageTier,
  type PriceDisplay,
} from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { EmptyState, Banner } from '@/components/ui-v3/Feedback'
import { formatINR } from '@/lib/format'
import { TierMatrix } from './TierMatrix'

export interface EditorPackageView {
  id: string
  title: string
  categoryId: string
  categoryName: string
  deliveryDays: number
  display: PriceDisplay
  groupId: string | null
  tier: PackageTier | null
  idealFor: string
  compareValues: Record<string, CompareValue>
}

export interface EditorGroupView {
  id: string
  titleEn: string
  titleHi: string
  compareRows: { key: string; labelEn: string; labelHi: string }[]
  packageIds: string[]
}

interface RowDraft {
  key: string
  label: string
  labelHi: string
  values: Partial<Record<PackageTier, CompareValue>>
}

interface Draft {
  id?: string
  titleEn: string
  titleHi: string
  slots: Record<PackageTier, string | null>
  idealFor: Record<PackageTier, string>
  rows: RowDraft[]
}

type CellMode = 'yes' | 'no' | 'text'
const modeOf = (v: CompareValue | undefined): CellMode => (v === true ? 'yes' : typeof v === 'string' ? 'text' : 'no')

function draftFrom(group: EditorGroupView | null, pkgs: EditorPackageView[]): Draft {
  const slots: Record<PackageTier, string | null> = { basic: null, standard: null, premium: null }
  const idealFor: Record<PackageTier, string> = { basic: '', standard: '', premium: '' }
  const rows: RowDraft[] = (group?.compareRows ?? []).map((r) => ({ key: r.key, label: r.labelEn, labelHi: r.labelHi, values: {} }))
  for (const id of group?.packageIds ?? []) {
    const p = pkgs.find((x) => x.id === id)
    if (!p?.tier) continue
    slots[p.tier] = p.id
    idealFor[p.tier] = p.idealFor
    for (const r of rows) {
      const v = p.compareValues[r.key]
      if (v !== undefined) r.values[p.tier] = v
    }
  }
  return { ...(group ? { id: group.id } : {}), titleEn: group?.titleEn ?? '', titleHi: group?.titleHi ?? '', slots, idealFor, rows }
}

/**
 * Experience v3 E4 (FR-4.1) — "Offer tiers?": arrange 2–3 of your packages in
 * one category as Basic / Standard / Premium, write the "Choose this if…"
 * line for each, build the comparison (≤ 12 rows) and see the buyer's matrix
 * live. Prices stay each package's own; the preview shows the server's display.
 */
export function TierGroupEditor({ packages, groups }: { packages: EditorPackageView[]; groups: EditorGroupView[] }) {
  const t = useTranslations('tier_editor')
  const tv = useTranslations('packages_v3')
  const router = useRouter()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const byId = useMemo(() => new Map(packages.map((p) => [p.id, p])), [packages])

  if (!draft) {
    return (
      <div className="space-y-4">
        {groups.length === 0 ? (
          <EmptyState
            title={t('empty_title')}
            body={t('empty_body')}
            action={<Button onClick={() => setDraft(draftFrom(null, packages))}><Plus className="h-4 w-4" /> {t('new_group')}</Button>}
          />
        ) : (
          <>
            <ul className="grouped" data-testid="tier-groups">
              {groups.map((g) => (
                <li key={g.id} className="grouped-row flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.titleEn}</span>
                    <span className="block text-xs text-foreground-secondary">
                      {g.packageIds.map((id) => { const p = byId.get(id); return p?.tier ? tv(`tier_${p.tier}`) : '' }).filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setDraft(draftFrom(g, packages))}>{t('edit')}</Button>
                </li>
              ))}
            </ul>
            <Button variant="secondary" onClick={() => setDraft(draftFrom(null, packages))}><Plus className="h-4 w-4" /> {t('new_group')}</Button>
          </>
        )}
      </div>
    )
  }

  const d = draft
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch })
  const chosen = PACKAGE_TIERS.map((tier) => d.slots[tier]).filter((x): x is string => !!x)
  const categoryId = chosen.length ? byId.get(chosen[0]!)?.categoryId : undefined
  // A package can sit in one group only; the category is fixed by the first pick.
  const eligible = packages.filter((p) => (!p.groupId || p.groupId === d.id) && (!categoryId || p.categoryId === categoryId))

  const payload = {
    ...(d.id ? { id: d.id } : {}),
    titleI18n: { en: d.titleEn.trim(), ...(d.titleHi.trim() ? { hi: d.titleHi.trim() } : {}) },
    compareRows: d.rows.map((r) => ({ key: r.key, labelI18n: { en: r.label.trim(), ...(r.labelHi.trim() ? { hi: r.labelHi.trim() } : {}) } })),
    tiers: PACKAGE_TIERS.filter((tier) => d.slots[tier]).map((tier) => ({
      packageId: d.slots[tier]!,
      tier,
      idealForI18n: d.idealFor[tier].trim() ? { en: d.idealFor[tier].trim() } : null,
      compareValues: Object.fromEntries(d.rows.filter((r) => r.values[tier] !== undefined).map((r) => [r.key, r.values[tier]!])),
    })),
  }
  const valid = packageGroupUpsertSchema.safeParse(payload)

  const setCell = (ri: number, tier: PackageTier, v: CompareValue | undefined) => {
    const rows = d.rows.map((r, i) => {
      if (i !== ri) return r
      const values = { ...r.values }
      if (v === undefined) delete values[tier]
      else values[tier] = v
      return { ...r, values }
    })
    set({ rows })
  }
  const nextKey = () => {
    let n = d.rows.length + 1
    while (d.rows.some((r) => r.key === `r${n}`)) n++
    return `r${n}`
  }

  async function save() {
    if (!valid.success) return
    setSaving(true)
    setError('')
    const res = await fetch('/api/v1/partner/package-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid.data),
    }).catch(() => null)
    setSaving(false)
    if (!res?.ok) {
      const j = (await res?.json().catch(() => null)) as { error?: unknown } | null
      const code = typeof j?.error === 'string' ? j.error : 'save_failed'
      setError(t.has(`err_${code}` as 'err_save_failed') ? t(`err_${code}` as 'err_save_failed') : t('err_save_failed'))
      return
    }
    setDraft(null)
    router.refresh()
  }

  async function ungroup() {
    if (!d.id) return
    setSaving(true)
    const res = await fetch(`/api/v1/partner/package-groups/${d.id}`, { method: 'DELETE' }).catch(() => null)
    setSaving(false)
    if (!res?.ok) { setError(t('err_save_failed')); return }
    setDraft(null)
    router.refresh()
  }

  const previewCols = PACKAGE_TIERS.filter((tier) => d.slots[tier] && byId.get(d.slots[tier]!)).map((tier) => {
    const p = byId.get(d.slots[tier]!)!
    return { id: p.id, tier, values: Object.fromEntries(d.rows.filter((r) => r.values[tier] !== undefined).map((r) => [r.key, r.values[tier]!])), deliveryDays: p.deliveryDays, display: p.display }
  })

  return (
    <div className="space-y-8" data-testid="tier-editor">
      <section className="space-y-3">
        <div>
          <Label htmlFor="tg-title">{t('group_title')}</Label>
          <Input id="tg-title" value={d.titleEn} maxLength={80} onChange={(e) => set({ titleEn: e.target.value })} placeholder={t('group_title_ph')} />
        </div>
        <div>
          <Label htmlFor="tg-title-hi">{t('group_title_hi')}</Label>
          <Input id="tg-title-hi" value={d.titleHi} maxLength={80} onChange={(e) => set({ titleHi: e.target.value })} />
        </div>
      </section>

      <section>
        <h2 className="t-headline">{t('tiers_heading')}</h2>
        <p className="mt-1 text-sm text-foreground-secondary">{t('tiers_help')}</p>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          {PACKAGE_TIERS.map((tier) => {
            const p = d.slots[tier] ? byId.get(d.slots[tier]!) : undefined
            return (
              <div key={tier} className="rounded-card border border-border bg-surface p-4">
                <p className="font-semibold">{tv(`tier_${tier}`)}{tier === 'premium' && <span className="ml-1 text-xs font-normal text-foreground-secondary">{t('optional')}</span>}</p>
                <Picker
                  className="mt-2"
                  label={t('pick_package')}
                  value={d.slots[tier]}
                  allowClear
                  clearLabel={t('none')}
                  options={eligible
                    .filter((x) => x.id === d.slots[tier] || !chosen.includes(x.id))
                    .map((x) => ({ value: x.id, label: `${x.title} · ${formatINR(x.display.taxablePaise)}`, keywords: x.categoryName }))}
                  onChange={(v) => set({ slots: { ...d.slots, [tier]: v } })}
                />
                {p && <p className="mt-2 text-xs text-foreground-secondary">{tv('price_plus_gst', { price: formatINR(p.display.taxablePaise) })} · {tv('days', { days: p.deliveryDays })}</p>}
                <Label htmlFor={`ideal-${tier}`} className="mt-3 block">{tv('ideal_for_label')}</Label>
                <Input
                  id={`ideal-${tier}`}
                  value={d.idealFor[tier]}
                  maxLength={IDEAL_FOR_MAX}
                  onChange={(e) => set({ idealFor: { ...d.idealFor, [tier]: e.target.value } })}
                  placeholder={t('ideal_for_ph')}
                />
                <p className="mt-1 text-right text-[11px] tabular-nums text-foreground-tertiary">{d.idealFor[tier].length}/{IDEAL_FOR_MAX}</p>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="t-headline">{t('rows_heading')}</h2>
        <p className="mt-1 text-sm text-foreground-secondary">{t('rows_help', { max: COMPARE_ROWS_MAX })}</p>
        <ul className="mt-3 space-y-3">
          {d.rows.map((r, ri) => (
            <li key={r.key} className="rounded-card border border-border bg-surface p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <Input aria-label={t('row_label')} value={r.label} maxLength={60} placeholder={t('row_label_ph')}
                    onChange={(e) => set({ rows: d.rows.map((x, i) => (i === ri ? { ...x, label: e.target.value } : x)) })} />
                </div>
                <Button size="sm" variant="ghost" aria-label={t('remove_row')} onClick={() => set({ rows: d.rows.filter((_, i) => i !== ri) })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {PACKAGE_TIERS.filter((tier) => d.slots[tier]).map((tier) => {
                  const v = r.values[tier]
                  const mode = modeOf(v)
                  return (
                    <div key={tier}>
                      <p className="mb-1 text-xs text-foreground-secondary">{tv(`tier_${tier}`)}</p>
                      <SegmentedControl<CellMode>
                        size="sm"
                        ariaLabel={`${r.label || t('row_label')} · ${tv(`tier_${tier}`)}`}
                        options={[
                          { value: 'yes', label: '✓', ariaLabel: tv('included') },
                          { value: 'no', label: '—', ariaLabel: tv('not_included') },
                          { value: 'text', label: t('cell_text') },
                        ]}
                        value={mode}
                        onChange={(m) => setCell(ri, tier, m === 'yes' ? true : m === 'no' ? undefined : typeof v === 'string' ? v : '')}
                      />
                      {mode === 'text' && (
                        <Input className="mt-1" aria-label={t('cell_text')} value={typeof v === 'string' ? v : ''} maxLength={COMPARE_TEXT_MAX}
                          onChange={(e) => setCell(ri, tier, e.target.value)} />
                      )}
                    </div>
                  )
                })}
              </div>
            </li>
          ))}
        </ul>
        {d.rows.length < COMPARE_ROWS_MAX && (
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => set({ rows: [...d.rows, { key: nextKey(), label: '', labelHi: '', values: {} }] })}>
            <Plus className="h-4 w-4" /> {t('add_row')}
          </Button>
        )}
      </section>

      {previewCols.length >= 2 && (
        <section>
          <h2 className="t-headline inline-flex items-center gap-2"><Layers className="h-4 w-4" /> {t('preview')}</h2>
          <div className="mt-3 rounded-card border border-border bg-surface p-3">
            <TierMatrix rows={d.rows.map((r) => ({ key: r.key, label: r.label || '…' }))} columns={previewCols} />
          </div>
        </section>
      )}

      {error && <Banner tone="critical">{error}</Banner>}
      {!valid.success && chosen.length >= 2 && <p className="text-sm text-foreground-secondary">{t('incomplete')}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setDraft(null); setError('') }}>{t('cancel')}</Button>
          {d.id && <Button variant="danger" onClick={ungroup} loading={saving}>{t('ungroup')}</Button>}
        </div>
        <Button onClick={save} disabled={!valid.success} loading={saving} data-testid="tier-save">{t('save')}</Button>
      </div>
    </div>
  )
}
