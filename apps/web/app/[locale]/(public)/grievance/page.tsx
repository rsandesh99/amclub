import { getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { GrievanceOfficerBlock } from '@/components/legal/GrievanceOfficerBlock'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, SUPPORT_CONTACT, whatsappHref } from '@/lib/legal/grievance'

// Static — changes only when the officer facts or copy change.
export const revalidate = 86400

// DRAFT FOR COUNSEL REVIEW (Phase 2, 2026-08-28): page copy states the
// statutory officer + the 24 h / 15 d commitments; wording not yet reviewed
// by counsel. Facts live in lib/legal/grievance.ts, copy in messages/*.json.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('grievance')
  return { title: t('title'), description: t('intro') }
}

export default async function GrievancePage() {
  const t = await getTranslations('grievance')
  const sla = { ackHours: GRIEVANCE_SLA.acknowledgeHours, resolveDays: GRIEVANCE_SLA.resolveDays }

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-3xl font-bold text-foreground">{t('title')}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-foreground-secondary [text-wrap:pretty]">{t('intro')}</p>

      <div className="mt-8">
        <GrievanceOfficerBlock />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-foreground">{t('how_heading')}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary [text-wrap:pretty]">{t('how_body')}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href={`mailto:${GRIEVANCE_OFFICER.email}?subject=${encodeURIComponent(t('email_subject'))}`}
            className="inline-flex min-h-11 items-center rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong"
          >
            {t('cta_email')}
          </a>
          <a
            href={whatsappHref(SUPPORT_CONTACT.whatsappE164, t('whatsapp_prefill'))}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-button border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {t('cta_whatsapp')}
          </a>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-foreground-secondary">{t('what_happens', sla)}</p>
      </section>

      <p className="mt-10 border-t border-border pt-6 text-sm text-foreground-secondary">
        {t('see_also')}{' '}
        <Link href="/terms" className="underline underline-offset-2 hover:text-primary">{t('terms_link')}</Link>
        {' · '}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-primary">{t('privacy_link')}</Link>
        {' · '}
        <Link href="/refund-policy" className="underline underline-offset-2 hover:text-primary">{t('refund_link')}</Link>
        {' · '}
        <Link href="/help" className="underline underline-offset-2 hover:text-primary">{t('help_link')}</Link>
      </p>
    </article>
  )
}
