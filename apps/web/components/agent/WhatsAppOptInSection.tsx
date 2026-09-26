'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface Grant { id: string; channel: string; channel_identity: string | null; created_at: string }

/**
 * WhatsApp opt-in state (S0.5). Shows the number bound to this account (the
 * whatsapp grant's channel_identity), lets the user revoke, and offers the
 * "Message us on WhatsApp" deep link that pre-fills START so the inbound job
 * creates the grant from their own phone. Rendered only when AGENT_ENABLED.
 */
export function WhatsAppOptInSection({ businessNumber }: { businessNumber: string | null }) {
  const t = useTranslations('agent_grants')
  const { toast } = useToast()
  const [grant, setGrant] = useState<Grant | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const d = await fetch('/api/v1/agent/grants', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { grants: [] }))
    const grants: Grant[] = d.grants ?? []
    setGrant(grants.find((g) => g.channel === 'whatsapp') ?? null)
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  async function revoke() {
    if (!grant) return
    setBusy(true)
    // Stop means every WhatsApp grant (a provider who is also a buyer can hold one per persona), not just the one shown.
    const d = await fetch('/api/v1/agent/grants', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { grants: [] }))
    const ids = ((d.grants ?? []) as Grant[]).filter((g) => g.channel === 'whatsapp').map((g) => g.id)
    const results = await Promise.all((ids.length ? ids : [grant.id]).map((id) => fetch(`/api/v1/agent/grants?id=${id}`, { method: 'DELETE' })))
    setBusy(false)
    if (results.every((r) => r.ok || r.status === 404)) { toast(t('whatsapp_revoked')); await load() } else { toast(t('action_failed')) }
  }

  const masked = grant?.channel_identity ? grant.channel_identity.replace(/\d(?=\d{4})/g, '•') : null
  const deepLink = businessNumber ? `https://wa.me/${businessNumber.replace(/\D/g, '')}?text=${encodeURIComponent('START')}` : null

  return (
    <section className="rounded-card border border-border bg-surface p-4 text-sm shadow-card">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('whatsapp_title')}</h2>
      <p className="text-foreground-secondary">{t('whatsapp_subtitle')}</p>
      <div className="mt-3">
        {loading ? (
          <p className="text-xs text-foreground-secondary">{t('loading')}</p>
        ) : grant ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-success">{t('whatsapp_bound', { number: masked ?? '' })}</span>
            <Button size="sm" variant="outline" loading={busy} onClick={revoke}>{t('whatsapp_stop')}</Button>
          </div>
        ) : deepLink ? (
          <a href={deepLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-button bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-strong">
            {t('whatsapp_message_us')}
          </a>
        ) : (
          <p className="text-xs text-foreground-secondary">{t('whatsapp_not_available')}</p>
        )}
      </div>
      <p className="mt-2 text-xs text-foreground-secondary">{t('whatsapp_hint')}</p>
    </section>
  )
}
