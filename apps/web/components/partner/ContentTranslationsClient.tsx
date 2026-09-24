'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ContentField, ContentTranslateLang, ContentTranslationView } from '@amclub/shared'
import type { TranslatableSubject } from '@/lib/translations/content'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useAnalytics } from '@/components/providers/posthog'

type State = { subjects: TranslatableSubject[]; drafts: ContentTranslationView[] }
const LANG_LABEL: Record<ContentTranslateLang, string> = { hi: 'हिंदी', te: 'తెలుగు', ta: 'தமிழ்' }

/**
 * E14 FR-14.3 — side by side: the provider's English, the live translation (if
 * any) and the open draft for the chosen language. Draft → edit → Approve (the
 * only write a buyer ever sees) or Discard. Money and numbers are never edited
 * here: the server refuses a text whose numbers differ from the English.
 */
export function ContentTranslationsClient({ initial }: { initial: State }) {
  const t = useTranslations('content_translate')
  const analytics = useAnalytics()
  const [state, setState] = useState<State>(initial)
  const [lang, setLang] = useState<ContentTranslateLang>('te')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function refresh() {
    const res = await fetch('/api/v1/partner/translations', { cache: 'no-store' })
    if (res.ok) setState((await res.json()) as State)
  }
  async function draft(s: TranslatableSubject) {
    setBusy(`draft:${s.kind}:${s.id}`); setNotice(null)
    const res = await fetch('/api/v1/partner/translations/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectKind: s.kind, ...(s.kind === 'package' ? { subjectId: s.id } : {}), lang }) })
    const j = (await res.json().catch(() => ({}))) as { skipped?: { field: string }[] }
    setBusy(null)
    if (!res.ok) { setNotice(res.status === 429 ? t('err_rate') : t('err_draft')); return }
    if (j.skipped?.length) setNotice(t('skipped', { n: j.skipped.length }))
    analytics.capture('content_translation_drafted', { lang, kind: s.kind, device: 'web' })
    await refresh()
  }
  async function decide(d: ContentTranslationView, action: 'approve' | 'reject') {
    setBusy(`${action}:${d.id}`); setNotice(null)
    const edited = edits[d.id]
    const res = await fetch(`/api/v1/partner/translations/${d.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'approve' && edited !== undefined && edited !== d.draftText ? { text: edited } : {}) })
    const j = (await res.json().catch(() => ({}))) as { code?: string }
    setBusy(null)
    if (!res.ok) { setNotice(j.code === 'text_rejected' ? t('err_rejected') : j.code === 'source_changed' ? t('err_source_changed') : t('err_decide')); await refresh(); return }
    if (action === 'approve') analytics.capture('content_translation_approved', { lang: d.lang, edited: edited !== undefined && edited !== d.draftText, device: 'web' })
    await refresh()
  }

  const draftFor = (s: TranslatableSubject, field: ContentField) => state.drafts.find((d) => d.subjectKind === s.kind && d.subjectId === s.id && d.field === field && d.lang === lang)

  return (
    <div className="mt-6 space-y-5">
      <SegmentedControl<ContentTranslateLang> ariaLabel={t('language')} value={lang} onChange={setLang} options={(['hi', 'te', 'ta'] as const).map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
      <p className="text-xs text-foreground-secondary">{t('rules')}</p>
      {notice && <p className="rounded-card border border-border bg-muted px-3 py-2 text-sm" role="status">{notice}</p>}
      {state.subjects.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
      {state.subjects.map((s) => (
        <section key={`${s.kind}:${s.id}`} className="rounded-card border border-border bg-surface p-4" data-subject={`${s.kind}:${s.id}`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate font-semibold" title={s.label}>{s.kind === 'profile' ? t('profile_about') : s.label}</h2>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void draft(s)} data-testid={`draft-${s.kind}-${s.id}`}>
              {busy === `draft:${s.kind}:${s.id}` ? t('drafting') : t('draft', { lang: LANG_LABEL[lang] })}
            </Button>
          </div>
          <div className="mt-3 space-y-4">
            {s.fields.map((f) => {
              const d = draftFor(s, f.field)
              const live = f.live[lang]
              return (
                <div key={f.field} className="grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-foreground-secondary">{t(`field_${f.field}`)} · English</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{f.source}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-foreground-secondary">
                      {t(`field_${f.field}`)} · {LANG_LABEL[lang]} {live && f.machine[lang] && <Badge variant="default" className="ml-1">{t('translated_badge')}</Badge>}
                    </p>
                    {live && !d && <p className="mt-1 whitespace-pre-wrap text-sm" lang={lang}>{live}</p>}
                    {!live && !d && <p className="mt-1 text-sm text-foreground-secondary">{t('none_yet')}</p>}
                    {d && (
                      <div className="mt-1 space-y-2" data-draft={d.id}>
                        <Textarea lang={lang} rows={f.field === 'about' ? 5 : 2} value={edits[d.id] ?? d.draftText} onChange={(e) => setEdits((m) => ({ ...m, [d.id]: e.target.value }))} aria-label={t('draft_label', { field: t(`field_${f.field}`) })} />
                        <p className="text-xs text-foreground-secondary">{t('draft_note')}</p>
                        <div className="flex gap-2">
                          <Button size="sm" disabled={busy !== null} onClick={() => void decide(d, 'approve')}>{t('approve')}</Button>
                          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(d, 'reject')}>{t('discard')}</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
