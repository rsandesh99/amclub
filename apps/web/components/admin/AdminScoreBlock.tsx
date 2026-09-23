'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * S2.4 — the admin score block (provider or buyer): snapshot, components with raw counts, the last 10 score events.
 * Admin-only route; buyer scores are shown nowhere else in v1 (ADR-010 §6). Renders nothing until the data loads.
 */
export function AdminScoreBlock({ side, id }: { side: 'provider' | 'buyer'; id: string }) {
  const t = useTranslations('admin_score')
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    let live = true
    void fetch(`/api/v1/admin/score/${side}/${id}`, { cache: 'no-store' }).then(async (r) => { if (live && r.ok) setData(await r.json()) })
    return () => { live = false }
  }, [side, id])
  if (!data) return null
  return (
    <div className="rounded-card border border-border bg-surface p-4" data-testid={`admin-score-${side}`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{side === 'provider' ? t('title') : t('buyer_title')}</h2>
        <span className="text-sm tabular-nums">{!data.computed ? t('not_computed') : data.score === null ? t('gated') : `${data.score} / 100`} <span className="text-xs text-foreground-secondary">({data.version})</span></span>
      </div>
      {data.components.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-foreground-secondary"><th className="py-1">{t('component')}</th><th>{t('value')}</th><th>{t('weight')}</th><th>{t('sample')}</th><th>{t('raw')}</th></tr></thead>
          <tbody>
            {data.components.map((c: any) => (
              <tr key={c.key} className="border-t border-border">
                <td className="py-1 font-medium">{c.key}</td>
                <td className="tabular-nums">{c.value ?? '—'}</td>
                <td className="tabular-nums">{c.weight}</td>
                <td className="tabular-nums">{c.sample}</td>
                <td className="text-foreground-secondary">{Object.entries(c.raw ?? {}).map(([k, v]) => `${k}=${v ?? '—'}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs font-semibold">{t('events')}</p>
      {data.events.length === 0 ? <p className="text-xs text-foreground-secondary">{t('none')}</p> : (
        <ul className="mt-1 space-y-0.5 text-xs">
          {data.events.map((e: any, i: number) => (
            <li key={i} className="tabular-nums">{new Date(e.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} · {e.from_score ?? '—'} → {e.to_score ?? '—'} ({e.delta > 0 ? '+' : ''}{e.delta}) · {e.reason}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
