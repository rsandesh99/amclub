'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Check, Hand } from 'lucide-react'
import { toolsForPersona, type AgentPersona } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { useAnalytics } from '@/components/providers/posthog'

interface Grant {
  id: string
  persona: string
  scopes: string[]
  channel: string
  channel_identity: string | null
  created_at: string
}

/**
 * Delegation grant toggle (S0.2), in plain words. Lets a person allow / turn
 * off the assistant working on their account on the web channel. The list says
 * what that means: what it may do on its own (read, draft, compare) and what
 * waits for their tap every time (the confirm gate: anything that sends,
 * spends or changes an order). Only rendered when AGENT_ENABLED (the page
 * gates on the flag).
 */
export function AgentGrantsSection({ persona }: { persona: AgentPersona }) {
  const t = useTranslations('agent_grants')
  const tTool = useTranslations('assistant_home.tool')
  const locale = useLocale()
  const { toast } = useToast()
  const analytics = useAnalytics()
  const [grant, setGrant] = useState<Grant | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const tools = toolsForPersona(persona)
  const scopes = tools.map((tool) => tool.name)
  // One line per plain-language label (support_lookup / nudge_counterparty repeat across personas, not within one).
  const onItsOwn = [...new Set(tools.filter((x) => !x.confirm).map((x) => x.name))]
  const afterTap = [...new Set(tools.filter((x) => x.confirm).map((x) => x.name))]

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
      // v2: the consent is the plain-language list below, not tool names.
      body: JSON.stringify({ persona, scopes, channel: 'web', locale, surface: 'web', consent_text_version: 'v2' }),
    })
    await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) { toast(t('granted')); analytics.capture('assistant_permission_changed', { persona, allowed: true }); await load() } else { toast(t('action_failed')) }
  }

  async function revoke() {
    if (!grant) return
    setBusy(true)
    const res = await fetch(`/api/v1/agent/grants?id=${grant.id}`, { method: 'DELETE' })
    await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) { toast(t('revoked')); analytics.capture('assistant_permission_changed', { persona, allowed: false }); await load() } else { toast(t('action_failed')) }
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="assistant-permission" data-testid="assistant-permission">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="assistant-permission" className="t-headline text-foreground">{t('title')}</h2>
          <p className="t-subhead mt-1 text-foreground-secondary">{t('subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loading ? (
            <span className="t-footnote text-foreground-secondary">{t('loading')}</span>
          ) : grant ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-chip bg-success/10 px-2.5 py-1 text-xs font-semibold text-success" data-testid="assistant-permission-state" data-allowed="true">
                <Check className="h-3.5 w-3.5" aria-hidden /> {t('active')}
              </span>
              <Button size="sm" variant="outline" loading={busy} onClick={revoke}>{t('revoke')}</Button>
            </>
          ) : (
            <>
              <span className="rounded-chip bg-foreground/5 px-2.5 py-1 text-xs font-semibold text-foreground-secondary" data-testid="assistant-permission-state" data-allowed="false">{t('inactive')}</span>
              <Button size="sm" loading={busy} onClick={grantIt}>{t('allow')}</Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="t-footnote font-semibold uppercase tracking-wide text-foreground-secondary">{t('on_its_own')}</h3>
          <ul className="mt-2 space-y-1.5">
            {onItsOwn.map((name) => (
              <li key={name} className="flex items-start gap-2 text-sm text-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                <span>{tTool(name as 'search_catalog')}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="t-footnote font-semibold uppercase tracking-wide text-foreground-secondary">{t('after_your_tap')}</h3>
          <ul className="mt-2 space-y-1.5">
            {afterTap.map((name) => (
              <li key={name} className="flex items-start gap-2 text-sm text-foreground">
                <Hand className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                <span>{tTool(name as 'search_catalog')}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-4 rounded-button bg-muted p-3 text-xs text-foreground-secondary">{t('consent_text')}</p>
    </section>
  )
}
