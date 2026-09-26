import { getTranslations } from 'next-intl/server'
import { Mail, MessageCircle, Clock, ShieldCheck, Wallet, RotateCcw, ArrowDownUp, Landmark, ShieldAlert, Lock } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, SUPPORT_CONTACT, whatsappHref } from '@/lib/legal/grievance'
import { PrivacyRequestLink } from '@/components/settings/PrivacyRequestLink'

// Static — support content rarely changes.
export const revalidate = 86400

// Contact facts live in lib/legal/grievance.ts (one source for help/grievance/terms).
const SUPPORT_EMAIL = SUPPORT_CONTACT.email
const SUPPORT_WHATSAPP = SUPPORT_CONTACT.whatsapp
const GRIEVANCE_EMAIL = GRIEVANCE_OFFICER.email

export default async function HelpPage() {
  const t = await getTranslations('help')

  // Each entry is a question (its title) and the answer.
  const faqs = [
    { icon: Wallet, q: t('faq_orders_q'), body: t('faq_orders') },
    { icon: RotateCcw, q: t('faq_refund_q'), body: t('faq_refund') },
    { icon: ShieldCheck, q: t('faq_verify_q'), body: t('faq_verify') },
    // ADR-004 — providers never bear gateway charges.
    { icon: Wallet, q: t('faq_fees_q'), body: t('faq_fees') },
    // S2.4 / ADR-010 §9 (e) — the main parameters that can order quotes, named without weights (Consumer Protection
    // (E-Commerce) Rules 2020 disclosure; counsel to confirm the clause). Factors only: the formula is not published.
    { icon: ArrowDownUp, q: t('faq_ranking_q'), body: t('faq_ranking') },
    // Experience v3 FR-4.5 — what "waiting on the government portal" means
    // (the external_wait pause); the package page's government line links here.
    { icon: Landmark, q: t('faq_govt_wait_q'), body: t('faq_govt_wait'), id: 'government-portal' },
  ]

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 space-y-8">
      <header>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-foreground-secondary">{t('subtitle')}</p>
      </header>

      {/* Contact rows share one 44px pitch (links are 44px tall by the global tap-target rule; the hours line
          matches), so the gaps between them are even. */}
      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="text-lg font-semibold">{t('contact_title')}</h2>
        <div className="mt-2 flex flex-col">
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex min-h-[44px] items-center gap-3 text-sm text-foreground hover:text-primary"
          >
            <Mail className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-foreground-secondary">{t('email_label')}:</span>
            <span className="font-medium">{SUPPORT_EMAIL}</span>
          </a>
          <a
            href={whatsappHref(SUPPORT_CONTACT.whatsappE164)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] items-center gap-3 text-sm text-foreground hover:text-primary"
          >
            <MessageCircle className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-foreground-secondary">{t('whatsapp_label')}:</span>
            <span className="font-medium">{SUPPORT_WHATSAPP}</span>
          </a>
          <p className="flex min-h-[44px] items-center gap-3 text-xs text-foreground-secondary">
            <Clock className="h-4 w-4 shrink-0" />
            {t('hours')}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('faq_title')}</h2>
        <div className="space-y-3">
          {faqs.map((f, i) => (
            <div key={i} id={'id' in f ? f.id : undefined} className="flex scroll-mt-24 gap-3 rounded-card border border-border bg-surface p-4">
              <f.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">{f.q}</h3>
                <p className="mt-1 text-sm text-foreground-secondary">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Audit §5 item 8 — the one official WhatsApp number and what we never ask for. */}
      <section className="flex gap-3 rounded-card border border-primary/30 bg-primary/5 p-5" data-testid="help-safety">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('safety_title')}</h2>
          <p className="mt-1 text-sm text-foreground-secondary">{t('safety_body')}</p>
          <Link href="/help/whatsapp-safety" className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline">
            {t('safety_link')}
          </Link>
        </div>
      </section>

      {/* ADR-030 §6 — DPDP requests: see, correct or erase your data. */}
      <section className="flex gap-3 rounded-card border border-border bg-surface p-5">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('privacy_title')}</h2>
          <p className="mt-1 text-sm text-foreground-secondary">{t('privacy_body')}</p>
          <PrivacyRequestLink className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline" />
        </div>
      </section>

      <section className="rounded-card border border-border bg-muted p-5">
        <h2 className="text-base font-semibold">{t('grievance_title')}</h2>
        <p className="mt-1 text-sm text-foreground-secondary">{t('grievance_body', { hours: GRIEVANCE_SLA.acknowledgeHours, days: GRIEVANCE_SLA.resolveDays })}</p>
        <p className="mt-1 text-sm text-foreground">{GRIEVANCE_OFFICER.name} · {GRIEVANCE_OFFICER.designation}</p>
        <a
          href={`mailto:${GRIEVANCE_EMAIL}`}
          className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline"
        >
          {GRIEVANCE_EMAIL}
        </a>
        <Link href="/grievance" className="ml-3 inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline">
          {t('grievance_link')}
        </Link>
      </section>
    </div>
  )
}
