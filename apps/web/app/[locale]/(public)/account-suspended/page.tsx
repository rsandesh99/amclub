import { getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { GRIEVANCE_OFFICER, SUPPORT_CONTACT, whatsappHref } from '@/lib/legal/grievance'

// Where a suspended buyer lands instead of the signup wizard (USER_EXPECTATIONS_AUDIT
// P0-8). Suspension = msme_profiles.deleted_at set by ops; the buyer shell and
// the auth wizard both redirect here so the profile can't be re-created or edited.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('suspended')
  return { title: t('title'), robots: { index: false } }
}

export default async function AccountSuspendedPage() {
  const t = await getTranslations('suspended')
  return (
    <article className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="font-display text-3xl font-bold text-foreground">{t('title')}</h1>
      <p className="mt-3 text-base leading-relaxed text-foreground-secondary [text-wrap:pretty]">{t('body')}</p>
      <p className="mt-3 text-base leading-relaxed text-foreground-secondary [text-wrap:pretty]">{t('money_note')}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <a
          href={`mailto:${GRIEVANCE_OFFICER.email}?subject=${encodeURIComponent(t('email_subject'))}`}
          className="inline-flex min-h-11 items-center rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong"
        >
          {t('cta_email')}
        </a>
        <a
          href={whatsappHref(SUPPORT_CONTACT.whatsappE164, t('whatsapp_text'))}
          className="inline-flex min-h-11 items-center rounded-button border border-primary px-5 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          {t('cta_whatsapp')}
        </a>
        <Link
          href="/grievance"
          className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary hover:underline"
        >
          {t('cta_grievance')}
        </Link>
      </div>
    </article>
  )
}
