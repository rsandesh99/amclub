'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MAX_ACTIVE_ADDONS } from '@amclub/shared'
import { formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAnalytics } from '@/components/providers/posthog'

export interface EditorAddon {
  id: string
  label_i18n: { en: string; hi?: string | null }
  price_paise: number
  days_delta: number
  extra_revisions: number
  active: boolean
}

interface Draft {
  label: string
  labelHi: string
  rupees: string
  days: string
  revisions: string
}
const EMPTY: Draft = { label: '', labelHi: '', rupees: '', days: '0', revisions: '0' }

/**
 * E12a / ADR 019 — the provider sets every add-on before a buyer sees it
 * (price before GST, a delivery change, extra revisions). Up to 3 active per
 * package; the server (and a DB trigger) enforce it. Every price the buyer
 * pays is computed on the server from these rows.
 */
export function AddOnsEditor({ packageId, initial }: { packageId: string; initial: EditorAddon[] }) {
  const t = useTranslations('addons')
  const analytics = useAnalytics()
  const [rows, setRows] = useState<EditorAddon[]>(initial)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const active = rows.filter((r) => r.active).length

  async function call(path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; addon?: EditorAddon }> {
    const res = await fetch(`/api/v1/partner/packages/${packageId}/addons${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const d = (await res.json().catch(() => ({}))) as { error?: string; addon?: EditorAddon }
    return { ok: res.ok, ...d }
  }

  async function add() {
    setNote(null)
    const rupees = Number(draft.rupees)
    if (!draft.label.trim() || !(rupees > 0)) return setNote(t('err_fields'))
    setBusy('new')
    const r = await call('', 'POST', {
      label_i18n: { en: draft.label.trim(), ...(draft.labelHi.trim() ? { hi: draft.labelHi.trim() } : {}) },
      // Unit conversion of the typed rupees (as the package wizard does); every total is the server's.
      price_paise: Math.round(rupees * 100),
      days_delta: Number(draft.days) || 0,
      extra_revisions: Number(draft.revisions) || 0,
      active: active < MAX_ACTIVE_ADDONS,
    })
    setBusy(null)
    if (!r.ok || !r.addon) return setNote(r.error === 'addon_limit' ? t('err_limit') : t('err_fields'))
    setRows((xs) => [...xs, r.addon!])
    setDraft(EMPTY)
    analytics.capture('package_addon_saved', { created: true, active: r.addon.active })
  }

  async function toggle(a: EditorAddon) {
    setNote(null)
    setBusy(a.id)
    const r = await call(`/${a.id}`, 'PATCH', { active: !a.active })
    setBusy(null)
    if (!r.ok || !r.addon) return setNote(r.error === 'addon_limit' ? t('err_limit') : t('err_save'))
    setRows((xs) => xs.map((x) => (x.id === a.id ? r.addon! : x)))
  }

  async function remove(a: EditorAddon) {
    setNote(null)
    setBusy(a.id)
    const r = await call(`/${a.id}`, 'DELETE')
    setBusy(null)
    if (!r.ok) return setNote(t('err_save'))
    setRows((xs) => xs.filter((x) => x.id !== a.id))
  }

  const effect = (a: { days_delta: number; extra_revisions: number }) =>
    [
      a.days_delta < 0 ? t('faster', { days: -a.days_delta }) : a.days_delta > 0 ? t('slower', { days: a.days_delta }) : null,
      a.extra_revisions > 0 ? t('more_revisions', { count: a.extra_revisions }) : null,
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <section className="mt-10 rounded-card border border-border bg-surface p-5" data-testid="addons-editor">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">{t('editor_title')}</h2>
        <span className="text-xs text-foreground-secondary">{t('active_count', { count: active, max: MAX_ACTIVE_ADDONS })}</span>
      </div>
      <p className="mt-1 text-sm text-foreground-secondary">{t('editor_body')}</p>

      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-separator">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3" data-addon={a.id}>
              <div>
                <p className="text-sm font-medium">
                  {a.label_i18n.en}
                  {!a.active && <span className="ml-2 rounded-pill bg-surface-sunken px-2 py-0.5 text-xs text-foreground-secondary">{t('paused')}</span>}
                </p>
                <p className="text-xs text-foreground-secondary">
                  {t('price_line', { price: formatINRExact(a.price_paise) })}
                  {effect(a) ? ` · ${effect(a)}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy === a.id} onClick={() => void toggle(a)}>
                  {a.active ? t('pause') : t('resume')}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy === a.id} onClick={() => void remove(a)}>
                  {t('remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="addon-label">{t('label')}</Label>
          <Input id="addon-label" maxLength={40} value={draft.label} placeholder={t('label_hint')} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="addon-label-hi">{t('label_hi')}</Label>
          <Input id="addon-label-hi" maxLength={40} value={draft.labelHi} onChange={(e) => setDraft({ ...draft, labelHi: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="addon-price">{t('price')}</Label>
          <Input id="addon-price" inputMode="numeric" value={draft.rupees} onChange={(e) => setDraft({ ...draft, rupees: e.target.value.replace(/[^0-9]/g, '') })} />
        </div>
        <div>
          <Label htmlFor="addon-days">{t('days')}</Label>
          <Input id="addon-days" inputMode="numeric" value={draft.days} onChange={(e) => setDraft({ ...draft, days: e.target.value.replace(/[^0-9-]/g, '') })} />
          <p className="mt-1 text-xs text-foreground-secondary">{t('days_hint')}</p>
        </div>
        <div>
          <Label htmlFor="addon-revisions">{t('revisions')}</Label>
          <Input id="addon-revisions" inputMode="numeric" value={draft.revisions} onChange={(e) => setDraft({ ...draft, revisions: e.target.value.replace(/[^0-9]/g, '') })} />
        </div>
      </div>
      {note && <p className="mt-3 text-sm text-danger" role="alert">{note}</p>}
      <Button type="button" className="mt-4" disabled={busy === 'new'} onClick={() => void add()}>
        {t('add')}
      </Button>
    </section>
  )
}
