import { useLocale, useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import type { ProviderTrust } from '@/lib/trust/provider-trust'
import { istDay } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { TrackedDetails } from '@/components/analytics/TrackedDetails'

const API_SOURCE: Record<string, string> = { gstin: 'src_gst_portal', udyam: 'src_udyam_portal', bank: 'src_penny_drop', pan: 'src_income_tax' }
const KIND_KEY: Record<string, string> = {
  gstin: 'gstin', pan: 'pan', bank: 'bank', icai: 'icai', icsi: 'icsi', bar_council: 'bar_council', icmai: 'icmai',
  gstp: 'gstp', dsa: 'dsa', ca: 'ca', credential: 'credential', msme_cert: 'msme_cert', udyam: 'udyam',
}
const VISIBLE = 5

/**
 * E3 TrustPanel (FR-3.2 / N10 / N11): "Verified by AMClub" — each check with
 * HOW it was checked and WHEN (never the number itself), then availability
 * and activity. Five lines, the rest behind "Show all".
 */
export function TrustPanel({ trust, className }: { trust: ProviderTrust; className?: string }) {
  const t = useTranslations('trust')
  const tc = useTranslations('catalog')
  const locale = useLocale()
  const line = (v: ProviderTrust['verification'][number]) => (
    <li key={v.kind} className="flex items-start gap-2 py-1.5">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" strokeWidth={2.25} aria-hidden />
      <span className="t-subhead text-foreground">
        <span className="font-medium">{tc(`badge_${KIND_KEY[v.kind] ?? 'credential'}` as 'badge_gstin')}</span>
        <span className="text-foreground-secondary">
          {' · '}
          {v.method === 'api' ? t(API_SOURCE[v.kind] ?? 'src_registry') : t('src_manual')}
          {v.verifiedAt ? ` · ${istDay(v.verifiedAt, locale)}` : ''}
        </span>
      </span>
    </li>
  )
  const head = trust.verification.slice(0, VISIBLE)
  const rest = trust.verification.slice(VISIBLE)
  return (
    <section aria-labelledby="trust-heading" className={cn('rounded-sheet bg-surface px-4 py-3 shadow-xs', className)}>
      <h2 id="trust-heading" className="t-footnote font-medium text-foreground-secondary">{t('verified_by')}</h2>
      {trust.verification.length === 0 ? (
        <p className="t-subhead py-1.5 text-foreground-secondary">{t('none_yet')}</p>
      ) : (
        <ul className="mt-1">{head.map(line)}</ul>
      )}
      {rest.length > 0 && (
        <TrackedDetails
          event="trust_panel_expanded"
          summary={t('show_all', { count: trust.verification.length })}
          summaryClassName="t-subhead min-h-0 cursor-pointer py-1 font-medium text-primary"
        >
          <ul>{rest.map(line)}</ul>
        </TrackedDetails>
      )}
      {(trust.availability || trust.activeThisWeek) && (
        <p className="t-subhead hairline-t mt-2 pt-2 text-foreground-secondary">
          {trust.availability?.kind === 'paused' && <span className="text-warning">{t('not_taking_work')}</span>}
          {trust.availability?.kind === 'from' && t('next_available', { date: istDay(`${trust.availability.date}T06:30:00Z`, locale) })}
          {trust.availability && trust.activeThisWeek && ' · '}
          {trust.activeThisWeek && <span className="text-success">{tc('active_this_week')}</span>}
        </p>
      )}
    </section>
  )
}
