import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINRExact } from '@/lib/format'
import { poolSaving } from '@amclub/shared'
import type { PoolDetail } from '@/lib/mart/pools'
import { PoolProgress, istDateTime } from './PoolProgress'

/**
 * Pool card for lists and the browse strip — the forwardable artifact's
 * on-site twin: photo, pool price vs list, molten progress, close time.
 * Server component; no JS shipped per card.
 */
export function PoolCard({ pool, progress, priority = false }: { pool: PoolDetail; progress: { pct: number; metPct: number; met: boolean; remainingToMin: number }; priority?: boolean }) {
  const t = useTranslations('mart')
  const saving = poolSaving(pool.unit_price_paise, pool.list_price_paise)
  const live = pool.status === 'open'
  const statusKey = `pool_status_${pool.status}` as 'pool_status_open'
  return (
    <Link
      href={`/mart/pools/${pool.id}` as '/services'}
      className={`${progress.met ? 'gold-edge-card' : 'sheet-card'} block p-3 transition hover:shadow-modal motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald`}
    >
      <div className="flex gap-3">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-[8px] bg-emerald-ink/5">
          {pool.imageUrl ? <Image src={pool.imageUrl} alt="" fill sizes="96px" className="object-cover" priority={priority} /> : <div className="jaali-ivory h-full w-full" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-body font-semibold leading-snug text-emerald-ink">{pool.title}</h3>
            <span className={`shrink-0 rounded-chip px-2 py-0.5 text-xs font-semibold ${live ? 'bg-emerald/10 text-emerald' : progress.met ? 'bg-gold/20 text-emerald-ink' : 'bg-emerald-ink/10 text-foreground-secondary'}`}>
              {t(pool.status === 'draft' ? 'pool_status_open' : statusKey)}
            </span>
          </div>
          {pool.seller && <p className="mt-0.5 truncate text-meta text-foreground-secondary">{pool.seller.displayName}{pool.seller.city ? ` · ${pool.seller.city}` : ''}</p>}
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-2xl font-bold tabular-nums text-ink">{formatINRExact(pool.unit_price_paise)}</span>
            <span className="text-meta text-foreground-secondary">{t('pool_per_unit', { unit: pool.unit })}</span>
            {pool.list_price_paise && saving.pct > 0 && (
              <span className="text-meta text-foreground-secondary"><s>{formatINRExact(pool.list_price_paise)}</s> <span className="font-semibold text-emerald">{t('pool_save', { pct: saving.pct })}</span></span>
            )}
          </div>
        </div>
      </div>
      <PoolProgress className="mt-3" committedQty={pool.committed_qty} targetQty={pool.target_qty} unit={pool.unit} progress={progress} />
      <p className="mt-1.5 text-xs text-foreground-secondary">
        {t('pool_members', { count: pool.member_count })} · {live ? t('pool_closes', { date: istDateTime(pool.closes_at) }) : t('pool_closed_on', { date: istDateTime(pool.closedAt ?? pool.closes_at) })}
      </p>
    </Link>
  )
}
