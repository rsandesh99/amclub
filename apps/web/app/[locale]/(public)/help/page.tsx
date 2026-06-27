import { getTranslations } from 'next-intl/server'
import { Mail, MessageCircle, Clock, ShieldCheck, Wallet, RotateCcw } from 'lucide-react'

// Static — support content rarely changes.
export const revalidate = 86400

const SUPPORT_EMAIL = 'support@amclub.in'
const SUPPORT_WHATSAPP = '+91 80000 00000'
const GRIEVANCE_EMAIL = 'grievance@amclub.in'

export default async function HelpPage() {
  const t = await getTranslations('help')

  const faqs = [
    { icon: Wallet, body: t('faq_orders') },
    { icon: RotateCcw, body: t('faq_refund') },
    { icon: ShieldCheck, body: t('faq_verify') },
  ]

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 space-y-8">
      <header>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-foreground-secondary">{t('subtitle')}</p>
      </header>

      <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-3">
        <h2 className="text-lg font-semibold">{t('contact_title')}</h2>
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="flex items-center gap-3 text-sm text-foreground hover:text-primary"
        >
          <Mail className="h-4 w-4 text-primary" />
          <span className="text-foreground-secondary">{t('email_label')}:</span>
          <span className="font-medium">{SUPPORT_EMAIL}</span>
        </a>
        <a
          href={`https://wa.me/${SUPPORT_WHATSAPP.replace(/[^0-9]/g, '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 text-sm text-foreground hover:text-primary"
        >
          <MessageCircle className="h-4 w-4 text-primary" />
          <span className="text-foreground-secondary">{t('whatsapp_label')}:</span>
          <span className="font-medium">{SUPPORT_WHATSAPP}</span>
        </a>
        <p className="flex items-center gap-2 pt-1 text-xs text-foreground-secondary">
          <Clock className="h-3.5 w-3.5" />
          {t('hours')}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('faq_title')}</h2>
        <div className="space-y-3">
          {faqs.map((f, i) => (
            <div key={i} className="flex gap-3 rounded-card border border-border bg-surface p-4">
              <f.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p className="text-sm text-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-card border border-border bg-muted p-5">
        <h2 className="text-base font-semibold">{t('grievance_title')}</h2>
        <p className="mt-1 text-sm text-foreground-secondary">{t('grievance_body')}</p>
        <a
          href={`mailto:${GRIEVANCE_EMAIL}`}
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          {GRIEVANCE_EMAIL}
        </a>
      </section>
    </div>
  )
}
