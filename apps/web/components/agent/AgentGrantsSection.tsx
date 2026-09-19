'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { toolsForPersona, type AgentPersona } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface Grant {
  id: string
  persona: string
  scopes: string[]
  channel: string
  channel_identity: string | null
  created_at: string
}

/**
 * Delegation grant toggle (S0.2). Lets a user allow / revoke the assistant
 * acting on their behalf on the web channel. Money- and status-changing actions
 * still require an explicit in-app confirmation every time (the confirm gate);
 * this grant only lets the assistant PROPOSE and run read-only steps. Only
 * rendered when AGENT_ENABLED (the parent page gates on the flag).
 */
export function AgentGrantsSection({ persona }: { persona: AgentPersona }) {
  const t = useTranslations('agent_grants')
  const locale = useLocale()
  const { toast } = useToast()
  const [grant, setGrant] = useState<Grant | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const scopes = toolsForPersona(persona).map((tool) => tool.name)

  const load = useCallback(async () => {
    setLoading(true)
    const d = await fetch('/api/v1/agent/grants', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { grants: [] }))
    const grants: Grant[] = d.grants ?? []
    setGrant(grants.find((g) => g.persona === persona && g.channel === 'web') ?? null)
    setLoading(false)
  }, [persona])
  useEffect(() => { void load() }, [load])

  async function grantIt() {
    setBusy(true)
    const res = await fetch('/api/v1/agent/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona, scopes, channel: 'web', locale, surface: 'web', consent_text_version: 'v1' }),
    })
    await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) { toast(t('granted')); await load() } else { toast(t('action_failed')) }
  }

  async function revoke() {
    if (!grant) return
    setBusy(true)
    const res = await fetch(`/api/v1/agent/grants?id=${grant.id}`, { method: 'DELETE' })
    await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) { toast(t('revoked')); await load() } else { toast(t('action_failed')) }
  }

  return (
    <section className="rounded-card border border-border bg-surface p-4 text-sm shadow-card">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('title')}</h2>
      <p className="text-foreground-secondary">{t('subtitle')}</p>

      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-foreground-secondary">
        {scopes.map((s) => <li key={s} className="font-mono">{s}</li>)}
      </ul>
      <p className="mt-2 text-xs text-foreground-secondary">{t('confirm_note')}</p>

      <p className="mt-3 rounded-button bg-muted p-3 text-xs text-foreground-secondary">{t('consent_text')}</p>

      <div className="mt-3">
        {loading ? (
          <p className="text-xs text-foreground-secondary">{t('loading')}</p>
        ) : grant ? (
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-success">{t('active')}</span>
            <Button size="sm" variant="outline" loading={busy} onClick={revoke}>{t('revoke')}</Button>
          </div>
        ) : (
          <Button size="sm" loading={busy} onClick={grantIt}>{t('allow')}</Button>
        )}
      </div>
    </section>
  )
}
