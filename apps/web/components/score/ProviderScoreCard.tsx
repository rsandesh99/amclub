import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { ProviderScoreCard as Card } from '@/lib/score/card'

/**
 * S2.4 — "Your AMC Score" on the partner dashboard (server-rendered from the provider's OWN snapshot; the page only
 * renders it when `score_card_enabled`). The number, or the gate; five component bars with weights and plain
 * definitions; the two weakest with tips; a 30-day sparkline; the private line and the addendum link.
 */
function Sparkline({ points }: { points: { on: string; score: number | null }[] }) {
  const pts = points.filter((p) => p.score !== null) as { on: string; score: number }[]
  if (pts.length < 2) return null
  const w = 240
  const h = 40
  const step = w / (pts.length - 1)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p.score / 100) * h).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full text-primary" role="img" aria-hidden="true" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export async function ProviderScoreCard({ card }: { card: Card }) {
  const t = await getTranslations('score_card')
  const label = (k: string) => t(`c_${k}` as 'c_on_time')
  const def = (k: string) => t(`d_${k}` as 'd_on_time')
  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card" data-testid="score-card" aria-labelledby="score-card-title">
      <div className="flex items-start justify-between gap-3">
        <h2 id="score-card-title" className="text-base font-semibold">{t('title')}</h2>
        {card.computed && card.score !== null && (
          <p className="text-right">
            <span className="font-display text-3xl font-bold text-primary tabular-nums">{card.score}</span>
            <span className="ml-1 text-xs text-foreground-secondary">{t('out_of')}</span>
          </p>
        )}
      </div>

      {!card.computed && <p className="mt-2 text-sm text-foreground-secondary">{t('not_computed')}</p>}
      {card.computed && card.score === null && (
        <div className="mt-2">
          <p className="text-sm font-medium">{t('not_enough', { have: card.gate.have.closed_orders, need: card.gate.needed.closed_orders })}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('not_enough_body', { need: card.gate.needed.closed_orders })}</p>
        </div>
      )}

      {card.note && (
        <p className="mt-3 rounded-button bg-primary/5 p-3 text-sm">
          <span className="font-medium text-primary">{t('note_label')}: </span>
          {card.note}
        </p>
      )}

      {card.components.length > 0 && (
        <ul className="mt-4 space-y-3">
          {card.components.map((c) => (
            <li key={c.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{label(c.key)}</span>
                <span className="text-xs text-foreground-secondary tabular-nums">
                  {c.value === null ? t('no_data') : c.value} · {t('weight', { weight: c.weight })}
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                {c.value !== null && <div className="h-full rounded-full bg-primary" style={{ width: `${c.value}%` }} />}
              </div>
              <p className="mt-1 text-xs text-foreground-secondary">{def(c.key)}</p>
            </li>
          ))}
        </ul>
      )}

      {card.tips.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-sm font-semibold">{t('tips_title')}</p>
          <ul className="mt-2 space-y-2">
            {card.tips.map((tip) => (
              <li key={tip.key} className="text-sm">
                <span className="font-medium">{label(tip.key)}: </span>
                {tip.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.trend.filter((p) => p.score !== null).length >= 2 && (
        <div className="mt-4">
          <p className="text-xs text-foreground-secondary">{t('trend_title')}</p>
          <Sparkline points={card.trend} />
        </div>
      )}

      <p className="mt-4 text-xs text-foreground-secondary">
        {t('private_line')}{' '}
        <Link href="/provider-addendum" className="text-primary underline underline-offset-2">{t('addendum_link')}</Link>
      </p>
    </section>
  )
}
