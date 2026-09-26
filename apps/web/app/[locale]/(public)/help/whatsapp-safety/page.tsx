import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Ban, Link2, MessageCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import { NEVER_ASKED_FOR, OFFICIAL_WEB_DOMAIN } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { OFFICIAL_WHATSAPP, SUPPORT_CONTACT, whatsappHref } from '@/lib/legal/grievance'

// Static — the facts change only with the env (a redeploy) or the copy.
export const revalidate = 86400

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('wa_safety')
  return { title: t('meta_title'), description: t('intro') }
}

/**
 * "Official AMClub on WhatsApp" (audit §5 item 8; PRD_WHATSAPP W1): the ONE
 * number and the display name, what we never ask for, the link rule (only our
 * domain — shared isOfficialLink), and how to report a fake. Linked from /help,
 * the footer, the WhatsApp settings and the mobile Help screen.
 */
export default async function WhatsAppSafetyPage() {
  const t = await getTranslations('wa_safety')
  const domain = OFFICIAL_WEB_DOMAIN

  return (
    <article className="mx-auto max-w-2xl space-y-8 px-4 py-10" data-testid="whatsapp-safety">
      <header>
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {t('eyebrow')}
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">{t('title')}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary [text-wrap:pretty]">{t('intro')}</p>
      </header>

      <section aria-labelledby="wa-number" className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 id="wa-number" className="flex items-center gap-2 text-lg font-semibold">
          <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
          {t('number_title')}
        </h2>
        <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-foreground" data-testid="official-number">{OFFICIAL_WHATSAPP.display}</p>
        <p className="mt-1 text-sm text-foreground-secondary">{t('number_body', { name: OFFICIAL_WHATSAPP.displayName })}</p>
        <a
          href={whatsappHref(OFFICIAL_WHATSAPP.e164)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 items-center rounded-button bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong"
        >
          {t('message_us')}
        </a>
      </section>

      <section aria-labelledby="wa-never" className="rounded-card border border-danger/20 bg-surface p-5">
        <h2 id="wa-never" className="flex items-center gap-2 text-lg font-semibold">
          <Ban className="h-5 w-5 text-danger" aria-hidden />
          {t('never_title')}
        </h2>
        <ul className="mt-3 space-y-2">
          {NEVER_ASKED_FOR.map((k) => (
            <li key={k} className="flex items-start gap-2 text-[15px] leading-relaxed">
              <Ban className="mt-1 h-4 w-4 shrink-0 text-danger" aria-hidden />
              <span>{t(`never_${k}`, { domain })}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="wa-links" className="rounded-card border border-border bg-surface p-5">
        <h2 id="wa-links" className="flex items-center gap-2 text-lg font-semibold">
          <Link2 className="h-5 w-5 text-primary" aria-hidden />
          {t('links_title', { domain })}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{t('links_body', { domain })}</p>
        <p className="mt-2 break-words rounded-button bg-muted px-3 py-2 font-mono text-xs text-foreground">{t('links_example', { domain })}</p>
      </section>

      <section aria-labelledby="wa-report" className="rounded-card border border-border bg-muted p-5">
        <h2 id="wa-report" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldAlert className="h-5 w-5 text-warning" aria-hidden />
          {t('report_title')}
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed">
          <li>{t('report_1')}</li>
          <li>{t('report_2')}</li>
          <li>{t('report_3', { email: SUPPORT_CONTACT.email })}</li>
          <li>{t('report_4')}</li>
        </ol>
      </section>

      <p className="border-t border-border pt-6 text-sm text-foreground-secondary">
        <Link href="/help" className="underline underline-offset-2 hover:text-primary">{t('help_link')}</Link>
        {' · '}
        <Link href="/grievance" className="underline underline-offset-2 hover:text-primary">{t('grievance_link')}</Link>
        {' · '}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-primary">{t('privacy_link')}</Link>
      </p>
    </article>
  )
}
