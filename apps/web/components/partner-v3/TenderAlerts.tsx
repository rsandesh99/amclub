'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { useAnalytics } from '@/components/providers/posthog'
import type { TenderAlertView } from '@/lib/partner-v3/tenders'

/**
 * E11 FR-11.6 — tender alerts: the notice and a link to the official portal,
 * plus Save / Not relevant. ALERTS ONLY — deliberately no bid, apply or submit
 * control (the experience rig asserts it).
 */
export function TenderAlerts({ alerts, labels }: { alerts: (TenderAlertView & { closes: string; band: string })[]; labels: { save: string; saved: string; notRelevant: string; portal: string; closes: string } }) {
  const t = useTranslations('partner_v3')
  const analytics = useAnalytics()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<Set<string>>(new Set(alerts.filter((a) => a.saved).map((a) => a.id)))
  const send = async (id: string, verdict: 'saved' | 'not_relevant') => {
    analytics.capture('tender_alert_feedback', { device: 'web', useful: verdict === 'saved' })
    const res = await fetch(`/api/v1/partner/tenders/${id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict }) }).catch(() => null)
    if (!res?.ok) return
    if (verdict === 'not_relevant') setHidden((h) => new Set(h).add(id))
    else setSaved((s) => new Set(s).add(id))
  }
  const live = alerts.filter((a) => !hidden.has(a.id))
  if (live.length === 0) return <p className="text-sm text-foreground-secondary">{t('tenders_empty')}</p>
  return (
    <ul className="space-y-3" data-testid="tender-alerts">
      {live.map((a) => (
        <li key={a.id} className="rounded-card border border-border bg-surface p-4" data-alert={a.id}>
          <p className="font-medium">{a.title}</p>
          <p className="t-footnote text-foreground-secondary">{a.department} · {a.band} · {labels.closes} {a.closes}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <a href={a.portalUrl} target="_blank" rel="noopener noreferrer" onClick={() => analytics.capture('tender_alert_opened', { device: 'web' })} className="inline-flex items-center gap-1 font-medium text-primary">
              {labels.portal} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            {saved.has(a.id) ? <span className="text-success">{labels.saved}</span> : <button type="button" onClick={() => send(a.id, 'saved')} className="text-foreground-secondary underline-offset-2 hover:underline">{labels.save}</button>}
            <button type="button" onClick={() => send(a.id, 'not_relevant')} className="text-foreground-secondary underline-offset-2 hover:underline">{labels.notRelevant}</button>
          </div>
        </li>
      ))}
    </ul>
  )
}
